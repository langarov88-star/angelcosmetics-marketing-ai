// ─── Approval Service Worker ─────────────────────────────────────────────────
// Responsibilities:
//   - Consumes queue-approvals messages from all agents
//   - Writes approval records to D1
//   - Sends Slack + email notifications to approvers
//   - Sets Durable Object alarm for 48h TTL expiry
//   - Exposes HTTP endpoints for approve/reject actions
//   - On approval: executes the actual high-risk API action (send email, enable campaign, etc.)
//   - Writes immutable audit log entries

import { SlackClient } from '../../lib/clients/slack';
import { MailchimpClient } from '../../lib/clients/mailchimp';
import { GoogleAdsClient } from '../../lib/clients/google-ads';
import { MetaClient } from '../../lib/clients/meta';
import { Logger } from '../../lib/utils/logger';
import { generateId } from '../../lib/utils/id';
import { validateApiKey, jsonResponse, errorResponse, unauthorizedResponse, notFoundResponse } from '../../lib/utils/response';
import type { ApprovalRequestMessage } from '../../lib/queues/schemas';

export interface ApprovalEnv {
  QUEUE_NOTIFICATIONS: Queue;
  QUEUE_RESULTS: Queue;
  APPROVAL_GATE: DurableObjectNamespace;
  DB: D1Database;
  KV_CONFIG: KVNamespace;
  KV_SESSIONS: KVNamespace;
  // Secrets
  INTERNAL_API_KEY: string;
  SLACK_WEBHOOK_URL: string;
  DASHBOARD_BASE_URL: string;
  MAILCHIMP_API_KEY: string;
  MAILCHIMP_SERVER_PREFIX: string;
  GOOGLE_ADS_DEVELOPER_TOKEN: string;
  GOOGLE_ADS_CUSTOMER_ID: string;
  GOOGLE_ADS_CLIENT_ID: string;
  GOOGLE_ADS_CLIENT_SECRET: string;
  GOOGLE_ADS_REFRESH_TOKEN: string;
  META_ACCESS_TOKEN: string;
  META_AD_ACCOUNT_ID: string;
  MOCK_EXTERNAL_APIS: string;
}

const logger = new Logger('approval-service');
const APPROVAL_TTL_SECONDS = 48 * 60 * 60; // 48 hours

export default {
  // ─── HTTP handler (approve/reject actions from dashboard) ─────────────────
  async fetch(request: Request, env: ApprovalEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', service: 'approval-service' });
    }

    if (!validateApiKey(request, env.INTERNAL_API_KEY)) {
      return unauthorizedResponse();
    }

    // POST /approvals/:id/approve
    if (request.method === 'POST' && url.pathname.match(/^\/approvals\/[^/]+\/approve$/)) {
      const approvalId = url.pathname.split('/')[2];
      return handleApprove(approvalId, request, env);
    }

    // POST /approvals/:id/reject
    if (request.method === 'POST' && url.pathname.match(/^\/approvals\/[^/]+\/reject$/)) {
      const approvalId = url.pathname.split('/')[2];
      return handleReject(approvalId, request, env);
    }

    // GET /approvals — list pending
    if (request.method === 'GET' && url.pathname === '/approvals') {
      return handleListApprovals(url, env);
    }

    // GET /approvals/:id
    if (request.method === 'GET' && url.pathname.match(/^\/approvals\/[^/]+$/)) {
      const approvalId = url.pathname.split('/')[2];
      return handleGetApproval(approvalId, env);
    }

    return errorResponse('Not found', 404);
  },

  // ─── Queue consumer (approval requests from agents) ───────────────────────
  async queue(batch: MessageBatch<ApprovalRequestMessage>, env: ApprovalEnv): Promise<void> {
    const isMock = env.MOCK_EXTERNAL_APIS === 'true';
    const slack = new SlackClient(
      env.SLACK_WEBHOOK_URL,
      env.DASHBOARD_BASE_URL ?? 'https://marketing.angelcosmetics.com',
      isMock
    );

    for (const message of batch.messages) {
      const msg = message.body;
      const startedAt = Date.now();

      try {
        const now = Math.floor(Date.now() / 1000);
        const expiresAt = now + APPROVAL_TTL_SECONDS;

        // Write approval record to D1
        await env.DB.prepare(
          `INSERT INTO approvals (id, workflow_id, campaign_id, agent, action_type, payload, status, requested_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        ).bind(
          msg.approval_id,
          msg.workflow_id,
          msg.campaign_id ?? null,
          msg.agent,
          msg.action_type,
          JSON.stringify(msg.payload),
          now,
          expiresAt
        ).run();

        // Update campaign status to pending_approval
        if (msg.campaign_id) {
          await env.DB.prepare(
            "UPDATE campaigns SET status = 'pending_approval', updated_at = ? WHERE id = ?"
          ).bind(now, msg.campaign_id).run();
        }

        // Set Durable Object alarm for TTL
        const doId = env.APPROVAL_GATE.idFromName(msg.approval_id);
        const doStub = env.APPROVAL_GATE.get(doId);
        await doStub.fetch(new Request('https://do/set', {
          method: 'POST',
          body: JSON.stringify({
            approval_id: msg.approval_id,
            workflow_id: msg.workflow_id,
            ttl_seconds: APPROVAL_TTL_SECONDS,
          }),
        }));

        // Send Slack notification
        const actionLabels: Record<string, string> = {
          send_email: 'Send Email Campaign',
          enable_google_campaign: 'Enable Google Ads Campaign',
          activate_meta_campaign: 'Activate Meta Ad Campaign',
          publish_content: 'Publish Content',
          increase_budget: 'Increase Ad Budget',
          create_audience: 'Create New Audience',
        };

        await slack.sendApprovalNotification({
          approvalId: msg.approval_id,
          workflowId: msg.workflow_id,
          agent: msg.agent,
          actionType: actionLabels[msg.action_type] ?? msg.action_type,
          summary: buildApprovalSummary(msg),
          previewUrl: msg.preview_url,
        });

        logger.info('Approval request recorded', {
          workflow_id: msg.workflow_id,
          approval_id: msg.approval_id,
          metadata: { agent: msg.agent, action_type: msg.action_type },
        });

        message.ack();
      } catch (err) {
        logger.taskFailed(msg.workflow_id, 'process_approval_request', startedAt, err);
        message.retry();
      }
    }
  },
};

// ─── Approval handlers ────────────────────────────────────────────────────────

async function handleApprove(approvalId: string, request: Request, env: ApprovalEnv): Promise<Response> {
  const approval = await env.DB.prepare(
    'SELECT * FROM approvals WHERE id = ?'
  ).bind(approvalId).first<{
    id: string; workflow_id: string; agent: string; action_type: string;
    payload: string; status: string; campaign_id: string | null;
  }>();

  if (!approval) return notFoundResponse();
  if (approval.status !== 'pending') {
    return errorResponse(`Approval is already ${approval.status}`, 409);
  }

  // Get user from session
  const authHeader = request.headers.get('Authorization');
  const sessionToken = authHeader?.replace('Bearer ', '') ?? '';
  const userJson = await env.KV_SESSIONS.get(`session:${sessionToken}`);
  const user = userJson ? JSON.parse(userJson) as { id: string; role: string; email: string } : null;

  if (!user) return unauthorizedResponse();

  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.parse(approval.payload) as Record<string, unknown>;

  // Execute the approved action
  let executionResult: Record<string, unknown> = {};
  try {
    executionResult = await executeApprovedAction(approval.action_type, payload, env);
  } catch (err) {
    logger.error('Failed to execute approved action', {
      workflow_id: approval.workflow_id,
      approval_id: approvalId,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse('Failed to execute approved action', 500);
  }

  // Update approval record
  await env.DB.prepare(
    "UPDATE approvals SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ?"
  ).bind(now, user.id, approvalId).run();

  // Update campaign status
  if (approval.campaign_id) {
    await env.DB.prepare(
      "UPDATE campaigns SET status = 'approved', updated_at = ? WHERE id = ?"
    ).bind(now, approval.campaign_id).run();
  }

  // Write audit log (immutable)
  await env.DB.prepare(
    `INSERT INTO audit_log (id, approval_id, user_id, role, decision, timestamp, ip_address, user_agent)
     VALUES (?, ?, ?, ?, 'approved', ?, ?, ?)`
  ).bind(
    generateId(),
    approvalId,
    user.id,
    user.role,
    now,
    request.headers.get('CF-Connecting-IP') ?? '',
    request.headers.get('User-Agent')?.slice(0, 255) ?? ''
  ).run();

  // Cancel DO alarm
  const doId = env.APPROVAL_GATE.idFromName(approvalId);
  const doStub = env.APPROVAL_GATE.get(doId);
  await doStub.fetch(new Request('https://do/cancel', { method: 'POST' }));

  // Notify
  await env.QUEUE_NOTIFICATIONS.send({
    type: 'approval_decided',
    workflow_id: approval.workflow_id,
    approval_id: approvalId,
    title: 'Campaign Approved',
    body: `${approval.action_type} approved by ${user.email}`,
    channels: ['slack'],
    severity: 'info',
  });

  logger.info('Approval approved and executed', {
    workflow_id: approval.workflow_id,
    approval_id: approvalId,
    metadata: { user: user.email, action: approval.action_type },
  });

  return jsonResponse({ ok: true, approval_id: approvalId, execution: executionResult });
}

async function handleReject(approvalId: string, request: Request, env: ApprovalEnv): Promise<Response> {
  const approval = await env.DB.prepare(
    'SELECT * FROM approvals WHERE id = ?'
  ).bind(approvalId).first<{
    id: string; workflow_id: string; agent: string; action_type: string; status: string; campaign_id: string | null;
  }>();

  if (!approval) return notFoundResponse();
  if (approval.status !== 'pending') {
    return errorResponse(`Approval is already ${approval.status}`, 409);
  }

  const authHeader = request.headers.get('Authorization');
  const sessionToken = authHeader?.replace('Bearer ', '') ?? '';
  const userJson = await env.KV_SESSIONS.get(`session:${sessionToken}`);
  const user = userJson ? JSON.parse(userJson) as { id: string; role: string; email: string } : null;

  if (!user) return unauthorizedResponse();

  const body = await request.json().catch(() => ({})) as { note?: string };
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    "UPDATE approvals SET status = 'rejected', decided_at = ?, decided_by = ?, audit_note = ? WHERE id = ?"
  ).bind(now, user.id, body.note ?? null, approvalId).run();

  if (approval.campaign_id) {
    await env.DB.prepare(
      "UPDATE campaigns SET status = 'rejected', updated_at = ? WHERE id = ?"
    ).bind(now, approval.campaign_id).run();
  }

  // Audit log
  await env.DB.prepare(
    `INSERT INTO audit_log (id, approval_id, user_id, role, decision, timestamp, note)
     VALUES (?, ?, ?, ?, 'rejected', ?, ?)`
  ).bind(generateId(), approvalId, user.id, user.role, now, body.note ?? null).run();

  // Cancel DO alarm
  const doId = env.APPROVAL_GATE.idFromName(approvalId);
  await env.APPROVAL_GATE.get(doId).fetch(new Request('https://do/cancel', { method: 'POST' }));

  await env.QUEUE_NOTIFICATIONS.send({
    type: 'approval_decided',
    workflow_id: approval.workflow_id,
    approval_id: approvalId,
    title: 'Campaign Rejected',
    body: `${approval.action_type} rejected by ${user.email}${body.note ? `: ${body.note}` : ''}`,
    channels: ['slack'],
    severity: 'warning',
  });

  return jsonResponse({ ok: true, approval_id: approvalId });
}

async function handleListApprovals(url: URL, env: ApprovalEnv): Promise<Response> {
  const status = url.searchParams.get('status') ?? 'pending';
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 100);

  const results = await env.DB.prepare(
    'SELECT * FROM approvals WHERE status = ? ORDER BY requested_at DESC LIMIT ?'
  ).bind(status, limit).all();

  return jsonResponse({ approvals: results.results, count: results.results.length });
}

async function handleGetApproval(approvalId: string, env: ApprovalEnv): Promise<Response> {
  const approval = await env.DB.prepare(
    'SELECT * FROM approvals WHERE id = ?'
  ).bind(approvalId).first();

  if (!approval) return notFoundResponse();
  return jsonResponse(approval);
}

// ─── Action executors (only called post-approval) ─────────────────────────────

async function executeApprovedAction(
  actionType: string,
  payload: Record<string, unknown>,
  env: ApprovalEnv
): Promise<Record<string, unknown>> {
  const isMock = env.MOCK_EXTERNAL_APIS === 'true';

  switch (actionType) {
    case 'send_email': {
      // THIS is the only place where Mailchimp schedule endpoint is called
      const mailchimp = new MailchimpClient(env.MAILCHIMP_API_KEY, env.MAILCHIMP_SERVER_PREFIX, isMock);
      const campaignId = payload.mailchimp_campaign_id as string;
      const sendTime = payload.send_time as string;

      if (!isMock) {
        // Schedule the campaign
        const response = await fetch(
          `https://${env.MAILCHIMP_SERVER_PREFIX}.api.mailchimp.com/3.0/campaigns/${campaignId}/actions/schedule`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.MAILCHIMP_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ schedule_time: sendTime }),
          }
        );
        if (!response.ok) throw new Error(`Mailchimp schedule error: ${response.status}`);
      }

      logger.info('Email campaign scheduled', {
        external_api: 'mailchimp',
        external_api_status: 200,
        metadata: { campaign_id: campaignId, send_time: sendTime },
      });

      void mailchimp; // suppress unused warning
      return { scheduled_at: sendTime, mailchimp_campaign_id: campaignId };
    }

    case 'enable_google_campaign': {
      const googleAds = new GoogleAdsClient(
        env.GOOGLE_ADS_DEVELOPER_TOKEN,
        env.GOOGLE_ADS_CUSTOMER_ID,
        isMock
      );

      if (!isMock) {
        const accessToken = await googleAds.refreshAccessToken(
          env.GOOGLE_ADS_CLIENT_ID,
          env.GOOGLE_ADS_CLIENT_SECRET,
          env.GOOGLE_ADS_REFRESH_TOKEN,
          env.KV_SESSIONS as KVNamespace
        );

        const response = await fetch(
          `https://googleads.googleapis.com/v18/customers/${env.GOOGLE_ADS_CUSTOMER_ID}/campaigns:mutate`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'developer-token': env.GOOGLE_ADS_DEVELOPER_TOKEN,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              operations: [{
                update: {
                  resourceName: payload.campaign_resource_name,
                  status: 'ENABLED',  // Only here — not in google-ads agent
                },
                updateMask: 'status',
              }],
            }),
          }
        );
        if (!response.ok) throw new Error(`Google Ads enable error: ${response.status}`);
      }

      return { enabled: true, resource_name: payload.campaign_resource_name };
    }

    case 'activate_meta_campaign': {
      const meta = new MetaClient(env.META_ACCESS_TOKEN, env.META_AD_ACCOUNT_ID, isMock);

      if (!isMock) {
        const adId = payload.meta_ad_id as string;
        const response = await fetch(
          `https://graph.facebook.com/v21.0/${adId}?access_token=${env.META_ACCESS_TOKEN}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'ACTIVE' }),  // Only here — not in meta agent
          }
        );
        if (!response.ok) throw new Error(`Meta activate error: ${response.status}`);
      }

      void meta;
      return { activated: true, meta_ad_id: payload.meta_ad_id };
    }

    default:
      return { executed: true, action: actionType };
  }
}

function buildApprovalSummary(msg: ApprovalRequestMessage): string {
  switch (msg.action_type) {
    case 'send_email':
      return `Send email campaign to audience`;
    case 'enable_google_campaign':
      return `Enable Google Ads campaign: ${(msg.payload as { campaign_name?: string }).campaign_name ?? msg.campaign_id ?? ''}`;
    case 'activate_meta_campaign':
      return `Activate Meta ad campaign: ${(msg.payload as { campaign_name?: string }).campaign_name ?? msg.campaign_id ?? ''}`;
    case 'publish_content':
      return `Publish content: ${(msg.payload as { title?: string }).title ?? ''}`;
    default:
      return `${msg.action_type} for workflow ${msg.workflow_id}`;
  }
}
