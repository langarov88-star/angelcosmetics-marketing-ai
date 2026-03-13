// ─── Orchestrator Worker ──────────────────────────────────────────────────────
// Central coordinator for the Angel Cosmetics AI Marketing Department.
// Receives cron triggers and HTTP POST requests from the dashboard.
// Fans out task messages to agent-specific Cloudflare Queues.
// Consumes the results queue and tracks workflow progress via Durable Objects.

import { z } from 'zod';
import { Logger } from '../../lib/utils/logger';
import { generateId } from '../../lib/utils/id';
import { validateApiKey, jsonResponse, errorResponse, unauthorizedResponse } from '../../lib/utils/response';
import { signMessage, buildSignaturePayload } from '../../lib/utils/signing';
import { WorkflowState } from './durable-objects/workflow-state';
import type { AgentResult } from '../../lib/queues/schemas';

export { WorkflowState };

// ─── Environment bindings ────────────────────────────────────────────────────

export interface OrchestratorEnv {
  // Queues — producers
  QUEUE_EMAIL: Queue;
  QUEUE_GOOGLE_ADS: Queue;
  QUEUE_META: Queue;
  QUEUE_CONTENT: Queue;
  QUEUE_CREATIVE: Queue;
  QUEUE_ANALYTICS: Queue;
  QUEUE_APPROVALS: Queue;
  QUEUE_NOTIFICATIONS: Queue;
  // Durable Objects
  WORKFLOW_STATE: DurableObjectNamespace;
  // Storage
  DB: D1Database;
  KV_CONFIG: KVNamespace;
  KV_CACHE: KVNamespace;
  R2_ASSETS: R2Bucket;
  R2_EXPORTS: R2Bucket;
  // Secrets
  INTERNAL_API_KEY: string;
  QUEUE_SIGNING_KEY: string;
}

// ─── HTTP request schema ─────────────────────────────────────────────────────

const TriggerWorkflowSchema = z.object({
  type: z.enum(['weekly_email', 'product_launch', 'monthly_report', 'content_creation', 'custom']),
  product_id: z.string().optional(),
  campaign_name: z.string().optional(),
  daily_budget: z.number().optional(),
  keywords: z.array(z.string()).optional(),
  audience_id: z.string().optional(),
});

const logger = new Logger('orchestrator');

// ─── Main Worker export ───────────────────────────────────────────────────────

export default {
  // ─── HTTP fetch handler ────────────────────────────────────────────────────
  async fetch(request: Request, env: OrchestratorEnv): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', service: 'orchestrator', timestamp: Date.now() });
    }

    // All other endpoints require API key auth
    if (!validateApiKey(request, env.INTERNAL_API_KEY)) {
      return unauthorizedResponse();
    }

    if (request.method === 'POST' && url.pathname === '/workflows') {
      return handleTriggerWorkflow(request, env);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/workflows/')) {
      const workflowId = url.pathname.split('/workflows/')[1];
      return handleGetWorkflow(workflowId, env);
    }

    return errorResponse('Not found', 404);
  },

  // ─── Cron trigger handler ──────────────────────────────────────────────────
  async scheduled(event: ScheduledEvent, env: OrchestratorEnv): Promise<void> {
    logger.info('Cron trigger fired', { metadata: { cron: event.cron } });

    if (event.cron === '0 8 * * 1') {
      // Monday 08:00 UTC — weekly email campaign
      await startWorkflow('weekly_email', { triggered_by: 'cron' }, env);
    } else if (event.cron === '0 6 1 * *') {
      // 1st of month 06:00 UTC — monthly analytics report
      const month = new Date().toISOString().slice(0, 7);
      await startWorkflow('monthly_report', { triggered_by: 'cron', month }, env);
    }
  },

  // ─── Queue consumer (results queue) ───────────────────────────────────────
  async queue(batch: MessageBatch<AgentResult>, env: OrchestratorEnv): Promise<void> {
    for (const message of batch.messages) {
      try {
        await handleAgentResult(message.body, env);
        message.ack();
      } catch (err) {
        logger.error('Failed to process agent result', {
          error: err instanceof Error ? err.message : String(err),
        });
        message.retry();
      }
    }
  },
};

// ─── Workflow triggers ────────────────────────────────────────────────────────

async function handleTriggerWorkflow(request: Request, env: OrchestratorEnv): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const parsed = TriggerWorkflowSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(`Validation failed: ${parsed.error.message}`);
  }

  const workflowId = await startWorkflow(parsed.data.type, {
    triggered_by: 'dashboard',
    ...parsed.data,
  }, env);

  return jsonResponse({ workflow_id: workflowId, status: 'started' }, 201);
}

async function handleGetWorkflow(workflowId: string, env: OrchestratorEnv): Promise<Response> {
  const result = await env.DB
    .prepare('SELECT * FROM workflows WHERE id = ?')
    .bind(workflowId)
    .first();

  if (!result) return errorResponse('Workflow not found', 404);
  return jsonResponse(result);
}

// ─── Core workflow orchestration ──────────────────────────────────────────────

async function startWorkflow(
  type: string,
  params: Record<string, unknown>,
  env: OrchestratorEnv
): Promise<string> {
  const workflowId = `wf_${type}_${Date.now()}_${generateId().slice(0, 8)}`;
  const startedAt = Date.now();

  logger.info('Starting workflow', { workflow_id: workflowId, metadata: { type, params } });

  // Check for active duplicate workflow via Durable Object
  const doId = env.WORKFLOW_STATE.idFromName(type);
  const doStub = env.WORKFLOW_STATE.get(doId);
  const isActive = await doStub.fetch(new Request(`https://do/is-active?type=${type}`));
  const activeData = await isActive.json() as { active: boolean; workflow_id?: string };

  if (activeData.active) {
    logger.warn('Duplicate workflow blocked', {
      workflow_id: workflowId,
      metadata: { existing: activeData.workflow_id },
    });
    return activeData.workflow_id!;
  }

  // Write workflow to D1
  await env.DB.prepare(
    'INSERT INTO workflows (id, type, status, triggered_by, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    workflowId,
    type,
    'in_progress',
    String(params.triggered_by ?? 'unknown'),
    Math.floor(startedAt / 1000),
    Math.floor(startedAt / 1000),
    JSON.stringify(params)
  ).run();

  // Register in Durable Object
  await doStub.fetch(new Request('https://do/register', {
    method: 'POST',
    body: JSON.stringify({ workflow_id: workflowId, type }),
  }));

  // Fan out tasks based on workflow type
  await fanOutTasks(workflowId, type, params, env);

  return workflowId;
}

async function fanOutTasks(
  workflowId: string,
  type: string,
  params: Record<string, unknown>,
  env: OrchestratorEnv
): Promise<void> {
  const baseMsg = (task: Record<string, unknown>) => ({
    workflow_id: workflowId,
    correlation_id: generateId(),
    timestamp: Date.now(),
    signature: '',  // filled below
    ...task,
  });

  const sign = async (msg: Record<string, unknown>) => {
    const sig = await signMessage(
      buildSignaturePayload(
        msg.workflow_id as string,
        msg.correlation_id as string,
        msg.timestamp as number
      ),
      env.QUEUE_SIGNING_KEY
    );
    return { ...msg, signature: sig };
  };

  switch (type) {
    case 'weekly_email': {
      // Step 1: fetch analytics, then email + creative in parallel (handled via DO state machine)
      const analyticsMsg = await sign(baseMsg({
        task: 'fetch_email_performance',
        lookback_days: 30,
      }));
      await env.QUEUE_ANALYTICS.send(analyticsMsg);
      break;
    }

    case 'product_launch': {
      // Fan out to creative, google-ads, meta in parallel
      const [creativeMsg, googleMsg, metaMsg] = await Promise.all([
        sign(baseMsg({ task: 'generate_images', campaign_type: 'meta', product_ids: [params.product_id], formats: ['1:1', '9:16', '1.91:1'] })),
        sign(baseMsg({ task: 'create_campaign', product_id: params.product_id, campaign_name: params.campaign_name, daily_budget_micros: (params.daily_budget as number) * 1_000_000 })),
        sign(baseMsg({ task: 'create_campaign', product_id: params.product_id, campaign_name: params.campaign_name, daily_budget: params.daily_budget })),
      ]);
      await Promise.all([
        env.QUEUE_CREATIVE.send(creativeMsg),
        env.QUEUE_GOOGLE_ADS.send(googleMsg),
        env.QUEUE_META.send(metaMsg),
      ]);
      break;
    }

    case 'monthly_report': {
      const analyticsMsg = await sign(baseMsg({
        task: 'monthly_report',
        month: params.month,
      }));
      await env.QUEUE_ANALYTICS.send(analyticsMsg);
      break;
    }

    case 'content_creation': {
      const contentMsg = await sign(baseMsg({
        task: 'draft_blog_post',
        target_keyword: params.keywords?.[0] ?? '',
        product_id: params.product_id,
      }));
      await env.QUEUE_CONTENT.send(contentMsg);
      break;
    }

    default:
      logger.warn('Unknown workflow type', { workflow_id: workflowId, metadata: { type } });
  }
}

async function handleAgentResult(result: AgentResult, env: OrchestratorEnv): Promise<void> {
  logger.info('Agent result received', {
    workflow_id: result.workflow_id,
    metadata: { agent: result.agent, status: result.status },
  });

  const now = Math.floor(Date.now() / 1000);

  // Update workflow updated_at
  await env.DB.prepare(
    'UPDATE workflows SET updated_at = ? WHERE id = ?'
  ).bind(now, result.workflow_id).run();

  // Handle sequential workflow chaining (e.g., analytics result triggers email task)
  if (result.agent === 'analytics' && result.status === 'success') {
    const workflow = await env.DB
      .prepare('SELECT type, metadata FROM workflows WHERE id = ?')
      .bind(result.workflow_id)
      .first<{ type: string; metadata: string }>();

    if (workflow?.type === 'weekly_email') {
      // Chain: analytics done → trigger creative + email
      const analyticsData = result.data as { top_products?: string[]; avg_open_rate?: number };
      const correlationId = generateId();
      const timestamp = Date.now();

      const sig = await signMessage(
        buildSignaturePayload(result.workflow_id, correlationId, timestamp),
        env.QUEUE_SIGNING_KEY
      );

      await env.QUEUE_CREATIVE.send({
        workflow_id: result.workflow_id,
        correlation_id: correlationId,
        timestamp,
        signature: sig,
        task: 'generate_images',
        campaign_type: 'email',
        product_ids: analyticsData.top_products ?? [],
        formats: ['1:1'],
      });
    }
  }

  // If creative for email done → trigger email draft
  if (result.agent === 'creative' && result.status === 'success') {
    const workflow = await env.DB
      .prepare('SELECT type FROM workflows WHERE id = ?')
      .bind(result.workflow_id)
      .first<{ type: string }>();

    if (workflow?.type === 'weekly_email') {
      const correlationId = generateId();
      const timestamp = Date.now();
      const sig = await signMessage(
        buildSignaturePayload(result.workflow_id, correlationId, timestamp),
        env.QUEUE_SIGNING_KEY
      );

      await env.QUEUE_EMAIL.send({
        workflow_id: result.workflow_id,
        correlation_id: correlationId,
        timestamp,
        signature: sig,
        task: 'draft_campaign',
        campaign_name: `Weekly Campaign ${new Date().toISOString().slice(0, 10)}`,
        audience_id: 'default',
        asset_keys: (result.data as { asset_keys?: string[] }).asset_keys ?? [],
      });
    }
  }

  // Check if all expected agents have responded → mark workflow complete
  await checkWorkflowCompletion(result.workflow_id, env);
}

async function checkWorkflowCompletion(workflowId: string, env: OrchestratorEnv): Promise<void> {
  // A workflow is complete when all campaigns for it are either approved/active/rejected
  // or when the analytics/content workflow has no pending approvals
  const pendingApprovals = await env.DB
    .prepare('SELECT COUNT(*) as count FROM approvals WHERE workflow_id = ? AND status = ?')
    .bind(workflowId, 'pending')
    .first<{ count: number }>();

  const pendingCampaigns = await env.DB
    .prepare("SELECT COUNT(*) as count FROM campaigns WHERE workflow_id = ? AND status IN ('draft', 'pending_approval')")
    .bind(workflowId)
    .first<{ count: number }>();

  if (pendingApprovals?.count === 0 && pendingCampaigns?.count === 0) {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "UPDATE workflows SET status = 'completed', updated_at = ?, completed_at = ? WHERE id = ?"
    ).bind(now, now, workflowId).run();

    logger.info('Workflow completed', { workflow_id: workflowId });

    // Notify via notifications queue
    await env.QUEUE_NOTIFICATIONS.send({
      type: 'workflow_complete',
      workflow_id: workflowId,
      title: 'Workflow Complete',
      body: `Workflow ${workflowId} has been completed successfully.`,
      channels: ['slack'],
      severity: 'info',
    });
  }
}
