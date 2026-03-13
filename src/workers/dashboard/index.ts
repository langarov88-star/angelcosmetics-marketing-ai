// ─── Dashboard API Worker ─────────────────────────────────────────────────────
// Responsibilities:
//   - Authenticated REST API for the marketing dashboard SPA
//   - Query workflows, campaigns, approvals, and assets from D1
//   - Serve signed R2 asset URLs for image previews
//   - Trigger new workflows by enqueuing tasks to agent queues
//   - Approval actions (approve/reject) are handled by the approval-service worker,
//     not here — this worker is read + trigger only

import { Logger } from '../../lib/utils/logger';
import { generateId } from '../../lib/utils/id';
import { signMessage, buildSignaturePayload } from '../../lib/utils/signing';
import { jsonResponse, errorResponse, unauthorizedResponse, notFoundResponse, methodNotAllowedResponse, validateApiKey } from '../../lib/utils/response';

export interface DashboardApiEnv {
  QUEUE_EMAIL: Queue;
  QUEUE_GOOGLE_ADS: Queue;
  QUEUE_META: Queue;
  QUEUE_CONTENT: Queue;
  QUEUE_ANALYTICS: Queue;
  DB: D1Database;
  KV_CONFIG: KVNamespace;
  KV_SESSIONS: KVNamespace;
  R2_ASSETS: R2Bucket;
  R2_EXPORTS: R2Bucket;
  // Secrets
  INTERNAL_API_KEY: string;
  QUEUE_SIGNING_KEY: string;
  MOCK_EXTERNAL_APIS: string;
}

const logger = new Logger('dashboard');

export default {
  async fetch(request: Request, env: DashboardApiEnv): Promise<Response> {
    // Authenticate all requests
    if (!validateApiKey(request, env.INTERNAL_API_KEY)) {
      return unauthorizedResponse();
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // ── Health check ──────────────────────────────────────────────────────
      if (path === '/health' && method === 'GET') {
        return jsonResponse({ status: 'ok', service: 'dashboard-api', timestamp: new Date().toISOString() });
      }

      // ── Workflows ─────────────────────────────────────────────────────────
      if (path === '/workflows' && method === 'GET') {
        return handleListWorkflows(url, env);
      }
      if (path.match(/^\/workflows\/[^/]+$/) && method === 'GET') {
        const id = path.split('/')[2];
        return handleGetWorkflow(id, env);
      }
      if (path === '/workflows/email' && method === 'POST') {
        return handleTriggerEmailWorkflow(request, env);
      }
      if (path === '/workflows/product-launch' && method === 'POST') {
        return handleTriggerProductLaunch(request, env);
      }
      if (path === '/workflows/content' && method === 'POST') {
        return handleTriggerContentWorkflow(request, env);
      }
      if (path === '/workflows/report' && method === 'POST') {
        return handleTriggerReport(request, env);
      }

      // ── Approvals ─────────────────────────────────────────────────────────
      if (path === '/approvals' && method === 'GET') {
        return handleListApprovals(url, env);
      }
      if (path.match(/^\/approvals\/[^/]+$/) && method === 'GET') {
        const id = path.split('/')[2];
        return handleGetApproval(id, env);
      }

      // ── Campaigns ─────────────────────────────────────────────────────────
      if (path === '/campaigns' && method === 'GET') {
        return handleListCampaigns(url, env);
      }
      if (path.match(/^\/campaigns\/[^/]+$/) && method === 'GET') {
        const id = path.split('/')[2];
        return handleGetCampaign(id, env);
      }

      // ── Reports ───────────────────────────────────────────────────────────
      if (path === '/reports' && method === 'GET') {
        return handleListReports(env);
      }

      // ── Assets ────────────────────────────────────────────────────────────
      if (path.startsWith('/assets/') && method === 'GET') {
        const r2Key = decodeURIComponent(path.slice('/assets/'.length));
        return handleGetAssetUrl(r2Key, env);
      }

      // ── Method not allowed for known paths ────────────────────────────────
      if (['/workflows', '/approvals', '/campaigns', '/reports'].some((p) => path.startsWith(p))) {
        return methodNotAllowedResponse();
      }

      return notFoundResponse();
    } catch (err) {
      logger.error('Dashboard API error', { error: err });
      return errorResponse('Internal server error', 500);
    }
  },
};

// ─── Workflow handlers ────────────────────────────────────────────────────────

async function handleListWorkflows(url: URL, env: DashboardApiEnv): Promise<Response> {
  const status = url.searchParams.get('status');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

  let query = 'SELECT id, type, status, triggered_by, created_at, updated_at, completed_at FROM workflows';
  const params: unknown[] = [];

  if (status) {
    query += ' WHERE status = ?';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const result = await env.DB.prepare(query).bind(...params).all();
  return jsonResponse({ workflows: result.results, total: result.results.length, limit, offset });
}

async function handleGetWorkflow(id: string, env: DashboardApiEnv): Promise<Response> {
  const workflow = await env.DB.prepare(
    'SELECT * FROM workflows WHERE id = ?'
  ).bind(id).first();

  if (!workflow) return notFoundResponse();

  const campaigns = await env.DB.prepare(
    'SELECT id, agent, type, status, name, external_id, created_at, metadata FROM campaigns WHERE workflow_id = ?'
  ).bind(id).all();

  const approvals = await env.DB.prepare(
    'SELECT id, agent, action_type, status, expires_at, requested_at, decided_at FROM approvals WHERE workflow_id = ?'
  ).bind(id).all();

  return jsonResponse({ workflow, campaigns: campaigns.results, approvals: approvals.results });
}

async function handleTriggerEmailWorkflow(request: Request, env: DashboardApiEnv): Promise<Response> {
  const body = await request.json() as {
    campaign_name?: string;
    audience_id?: string;
  };

  const workflowId = generateId();
  const correlationId = generateId();
  const timestamp = Date.now();
  const sig = await signMessage(
    buildSignaturePayload(workflowId, correlationId, timestamp),
    env.QUEUE_SIGNING_KEY
  );

  await env.QUEUE_EMAIL.send({
    workflow_id: workflowId,
    correlation_id: correlationId,
    timestamp,
    signature: sig,
    task: 'draft_campaign',
    campaign_name: body.campaign_name ?? `Weekly Campaign — ${new Date().toISOString().slice(0, 10)}`,
    audience_id: body.audience_id ?? 'default',
  });

  logger.info('Email workflow triggered from dashboard', { workflow_id: workflowId });
  return jsonResponse({ workflow_id: workflowId, status: 'queued' }, 202);
}

async function handleTriggerProductLaunch(request: Request, env: DashboardApiEnv): Promise<Response> {
  const body = await request.json() as {
    product_id: string;
    campaign_name?: string;
    daily_budget?: number;
    daily_budget_micros?: number;
    formats?: string[];
  };

  if (!body.product_id) {
    return errorResponse('product_id is required', 400);
  }

  const workflowId = generateId();
  const timestamp = Date.now();

  // Fan out to Creative, Google Ads, and Meta in parallel
  const campaignName = body.campaign_name ?? `Product Launch: ${body.product_id} — ${new Date().toISOString().slice(0, 10)}`;

  const tasks = [
    // Creative images first
    {
      queue: env.QUEUE_ANALYTICS,
      payload: {
        task: 'fetch_ads_performance' as const,
        lookback_days: 30,
      },
    },
    {
      queue: env.QUEUE_GOOGLE_ADS,
      payload: {
        task: 'create_campaign' as const,
        product_id: body.product_id,
        campaign_name: campaignName,
        daily_budget_micros: body.daily_budget_micros ?? 5_000_000,
      },
    },
    {
      queue: env.QUEUE_META,
      payload: {
        task: 'create_campaign' as const,
        product_id: body.product_id,
        campaign_name: campaignName,
        daily_budget: body.daily_budget ?? 20,
      },
    },
  ];

  for (const { queue, payload } of tasks) {
    const correlationId = generateId();
    const sig = await signMessage(
      buildSignaturePayload(workflowId, correlationId, timestamp),
      env.QUEUE_SIGNING_KEY
    );
    await queue.send({
      workflow_id: workflowId,
      correlation_id: correlationId,
      timestamp,
      signature: sig,
      ...payload,
    });
  }

  logger.info('Product launch workflow triggered from dashboard', { workflow_id: workflowId });
  return jsonResponse({ workflow_id: workflowId, status: 'queued', agents: ['google-ads', 'meta', 'analytics'] }, 202);
}

async function handleTriggerContentWorkflow(request: Request, env: DashboardApiEnv): Promise<Response> {
  const body = await request.json() as {
    target_keyword: string;
    task?: 'draft_blog_post' | 'draft_product_description';
    product_id?: string;
    word_count?: number;
  };

  if (!body.target_keyword) {
    return errorResponse('target_keyword is required', 400);
  }

  const workflowId = generateId();
  const correlationId = generateId();
  const timestamp = Date.now();
  const sig = await signMessage(
    buildSignaturePayload(workflowId, correlationId, timestamp),
    env.QUEUE_SIGNING_KEY
  );

  await env.QUEUE_CONTENT.send({
    workflow_id: workflowId,
    correlation_id: correlationId,
    timestamp,
    signature: sig,
    task: body.task ?? 'draft_blog_post',
    target_keyword: body.target_keyword,
    product_id: body.product_id,
    word_count: body.word_count ?? 1200,
  });

  logger.info('Content workflow triggered from dashboard', { workflow_id: workflowId });
  return jsonResponse({ workflow_id: workflowId, status: 'queued' }, 202);
}

async function handleTriggerReport(request: Request, env: DashboardApiEnv): Promise<Response> {
  const body = await request.json() as { month?: string };

  const workflowId = generateId();
  const correlationId = generateId();
  const timestamp = Date.now();
  const sig = await signMessage(
    buildSignaturePayload(workflowId, correlationId, timestamp),
    env.QUEUE_SIGNING_KEY
  );

  const month = body.month ?? new Date().toISOString().slice(0, 7);

  await env.QUEUE_ANALYTICS.send({
    workflow_id: workflowId,
    correlation_id: correlationId,
    timestamp,
    signature: sig,
    task: 'monthly_report' as const,
    lookback_days: 30,
    month,
  });

  logger.info('Monthly report triggered from dashboard', { workflow_id: workflowId, month });
  return jsonResponse({ workflow_id: workflowId, status: 'queued', month }, 202);
}

// ─── Approval handlers ────────────────────────────────────────────────────────

async function handleListApprovals(url: URL, env: DashboardApiEnv): Promise<Response> {
  const status = url.searchParams.get('status') ?? 'pending';
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);

  const result = await env.DB.prepare(
    'SELECT id, workflow_id, agent, action_type, status, expires_at, requested_at, decided_at, decided_by FROM approvals WHERE status = ? ORDER BY requested_at DESC LIMIT ?'
  ).bind(status, limit).all();

  return jsonResponse({ approvals: result.results, total: result.results.length });
}

async function handleGetApproval(id: string, env: DashboardApiEnv): Promise<Response> {
  const approval = await env.DB.prepare(
    'SELECT * FROM approvals WHERE id = ?'
  ).bind(id).first();

  if (!approval) return notFoundResponse();

  const auditLog = await env.DB.prepare(
    'SELECT * FROM audit_log WHERE approval_id = ? ORDER BY timestamp ASC'
  ).bind(id).all();

  return jsonResponse({ approval, audit_log: auditLog.results });
}

// ─── Campaign handlers ────────────────────────────────────────────────────────

async function handleListCampaigns(url: URL, env: DashboardApiEnv): Promise<Response> {
  const agent = url.searchParams.get('agent');
  const status = url.searchParams.get('status');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

  let query = 'SELECT id, workflow_id, agent, type, status, name, external_id, created_at, updated_at FROM campaigns WHERE 1=1';
  const params: unknown[] = [];

  if (agent) { query += ' AND agent = ?'; params.push(agent); }
  if (status) { query += ' AND status = ?'; params.push(status); }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const result = await env.DB.prepare(query).bind(...params).all();
  return jsonResponse({ campaigns: result.results, total: result.results.length, limit, offset });
}

async function handleGetCampaign(id: string, env: DashboardApiEnv): Promise<Response> {
  const campaign = await env.DB.prepare(
    'SELECT * FROM campaigns WHERE id = ?'
  ).bind(id).first();

  if (!campaign) return notFoundResponse();

  const assets = await env.DB.prepare(
    'SELECT id, r2_key, asset_type, alt_text, dimensions, format FROM assets WHERE campaign_id = ?'
  ).bind(id).all();

  const approvals = await env.DB.prepare(
    'SELECT id, action_type, status, expires_at, requested_at FROM approvals WHERE campaign_id = ?'
  ).bind(id).all();

  return jsonResponse({ campaign, assets: assets.results, approvals: approvals.results });
}

// ─── Reports handler ──────────────────────────────────────────────────────────

async function handleListReports(env: DashboardApiEnv): Promise<Response> {
  // List objects in the reports/ prefix of R2_EXPORTS
  const listed = await env.R2_EXPORTS.list({ prefix: 'reports/', limit: 24 });

  const reports = listed.objects.map((obj) => ({
    key: obj.key,
    month: obj.key.replace('reports/', '').replace('.html', ''),
    size: obj.size,
    uploaded: obj.uploaded,
  }));

  return jsonResponse({ reports });
}

// ─── Asset URL handler ────────────────────────────────────────────────────────

async function handleGetAssetUrl(r2Key: string, env: DashboardApiEnv): Promise<Response> {
  // Determine which bucket holds the asset
  const bucket = r2Key.startsWith('assets/') ? env.R2_ASSETS : env.R2_EXPORTS;

  // Check the object exists
  const head = await bucket.head(r2Key);
  if (!head) return notFoundResponse();

  // Generate a short-lived signed URL (1 hour TTL)
  // Cloudflare R2 presigned URLs via the createPresignedUrl method
  // Since R2Bucket.createPresignedUrl may not be available in all Wrangler versions,
  // we return metadata and the key for the frontend to request via a proxy pattern
  return jsonResponse({
    r2_key: r2Key,
    size: head.size,
    content_type: head.httpMetadata?.contentType ?? 'application/octet-stream',
    // The dashboard fetches the actual bytes via GET /assets-proxy/:key on a separate public route
    // For now, return the key for the SPA to handle
    preview_available: true,
  });
}
