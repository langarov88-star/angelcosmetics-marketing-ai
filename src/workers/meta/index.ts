// ─── Meta Ads Agent Worker ────────────────────────────────────────────────────
// Responsibilities:
//   - Generate ad copy (primary text, headline, description) via GPT-4o
//   - Create campaigns, ad sets, ad creatives, and ads in Meta with status PAUSED
//   - Fetch campaign insights for the orchestrator/analytics
//   - Request human approval before any campaign activation
//   - NEVER sets campaign or ad status to ACTIVE (only approval-service can do that)

import { MetaClient } from '../../lib/clients/meta';
import { OpenAIClient } from '../../lib/clients/openai';
import { Logger } from '../../lib/utils/logger';
import { generateCampaignId, generateApprovalId, generateId } from '../../lib/utils/id';
import { signMessage, buildSignaturePayload, verifySignature } from '../../lib/utils/signing';
import { ModelRouter } from '../../lib/utils/model-router';
import type { MetaTask } from '../../lib/queues/schemas';

export interface MetaAgentEnv {
  QUEUE_RESULTS: Queue;
  QUEUE_APPROVALS: Queue;
  DB: D1Database;
  KV_CONFIG: KVNamespace;
  KV_CACHE: KVNamespace;
  R2_ASSETS: R2Bucket;
  // Secrets
  OPENAI_API_KEY: string;
  META_ACCESS_TOKEN: string;
  META_AD_ACCOUNT_ID: string;
  META_PAGE_ID: string;
  QUEUE_SIGNING_KEY: string;
  INTERNAL_API_KEY: string;
  MOCK_EXTERNAL_APIS: string;
}

const logger = new Logger('meta');

export default {
  async fetch(_request: Request, _env: MetaAgentEnv): Promise<Response> {
    return new Response(JSON.stringify({ status: 'ok', service: 'agent-meta' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },

  async queue(batch: MessageBatch<MetaTask>, env: MetaAgentEnv): Promise<void> {
    const isMock = env.MOCK_EXTERNAL_APIS === 'true';
    const meta = new MetaClient(env.META_ACCESS_TOKEN, env.META_AD_ACCOUNT_ID, isMock);
    const openai = new OpenAIClient(env.OPENAI_API_KEY, isMock);
    const modelRouter = new ModelRouter(env.KV_CONFIG);

    for (const message of batch.messages) {
      const task = message.body;
      const startedAt = logger.taskStart(task.workflow_id, task.task);

      try {
        // Verify message signature
        const valid = await verifySignature(
          buildSignaturePayload(task.workflow_id, task.correlation_id, task.timestamp),
          task.signature,
          env.QUEUE_SIGNING_KEY
        );
        if (!valid) {
          logger.warn('Invalid message signature — dropping', { workflow_id: task.workflow_id });
          message.ack();
          continue;
        }

        let result: Record<string, unknown>;

        if (task.task === 'create_campaign') {
          result = await createMetaCampaign(task, env, { meta, openai, modelRouter });
        } else {
          result = await fetchMetaInsights(task, env, { meta });
        }

        // Publish result back to orchestrator
        const correlationId = generateId();
        const timestamp = Date.now();
        const sig = await signMessage(
          buildSignaturePayload(task.workflow_id, correlationId, timestamp),
          env.QUEUE_SIGNING_KEY
        );
        await env.QUEUE_RESULTS.send({
          workflow_id: task.workflow_id,
          correlation_id: correlationId,
          timestamp,
          signature: sig,
          agent: 'meta',
          status: 'success',
          data: result,
          approval_id: result.approval_id as string | undefined,
        });

        logger.taskEnd(task.workflow_id, task.task, startedAt);
        message.ack();
      } catch (err) {
        logger.taskFailed(task.workflow_id, task.task, startedAt, err);
        message.retry();
      }
    }
  },
};

// ─── Create campaign (paused) ─────────────────────────────────────────────────

async function createMetaCampaign(
  task: MetaTask,
  env: MetaAgentEnv,
  clients: { meta: MetaClient; openai: OpenAIClient; modelRouter: ModelRouter }
): Promise<Record<string, unknown>> {
  const campaignName = task.campaign_name ?? `Angel Cosmetics — ${new Date().toISOString().slice(0, 10)}`;
  const dailyBudgetCents = Math.round((task.daily_budget ?? 20) * 100); // default $20/day

  // 1. Generate ad copy with GPT-4o
  const adCopyModel = await clients.modelRouter.getModel('meta', 'ad_copy');
  const copyResult = await clients.openai.complete({
    model: adCopyModel.model as string,
    messages: [
      {
        role: 'system',
        content: `You are a Meta (Facebook/Instagram) ads specialist for Angel Cosmetics, a premium vegan cosmetics brand.
Write scroll-stopping ad copy. Primary text should be conversational and benefit-led.
Headline should be punchy (max 27 chars). Description should reinforce the CTA (max 27 chars).
Output valid JSON only.`,
      },
      {
        role: 'user',
        content: `Create Meta ad copy for: "${campaignName}"
${task.product_id ? `Product ID: ${task.product_id}` : ''}
${task.asset_keys?.length ? `Creative assets available: ${task.asset_keys.join(', ')}` : ''}

Output JSON:
{
  "primary_text": "...",
  "headline": "...",
  "description": "...",
  "call_to_action": "SHOP_NOW"
}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.75,
  });

  const adCopy = JSON.parse(copyResult.content) as {
    primary_text: string;
    headline: string;
    description: string;
    call_to_action: 'SHOP_NOW' | 'LEARN_MORE' | 'SIGN_UP' | 'GET_OFFER';
  };

  // 2. Create campaign (PAUSED)
  const campaign = await clients.meta.createCampaign({
    name: campaignName,
    objective: 'OUTCOME_TRAFFIC',
    status: 'PAUSED',
    special_ad_categories: [],
  });

  // 3. Create ad set (PAUSED) — targeting women 18-45 globally
  const adSet = await clients.meta.createAdSet({
    campaign_id: campaign.id,
    name: `${campaignName} — Ad Set`,
    status: 'PAUSED',
    daily_budget: dailyBudgetCents,
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'LINK_CLICKS',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    targeting: {
      age_min: 18,
      age_max: 45,
      genders: [2], // female
      geo_locations: { countries: ['US', 'GB', 'CA', 'AU'] },
    },
  });

  // 4. Create ad creative
  const pageId = env.META_PAGE_ID ?? 'REPLACE_WITH_PAGE_ID';
  const creative = await clients.meta.createAdCreative({
    name: `${campaignName} — Creative`,
    object_story_spec: {
      page_id: pageId,
      link_data: {
        link: 'https://angelcosmetics.com/',
        message: adCopy.primary_text,
        name: adCopy.headline,
        description: adCopy.description,
        call_to_action: {
          type: adCopy.call_to_action,
        },
      },
    },
  });

  // 5. Create ad (PAUSED)
  const ad = await clients.meta.createAd({
    name: `${campaignName} — Ad`,
    adset_id: adSet.id,
    creative: { creative_id: creative.id },
    status: 'PAUSED',
  });

  // 6. Write campaign record to D1
  const campaignId = generateCampaignId('meta');
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    'INSERT INTO campaigns (id, workflow_id, agent, type, status, external_id, name, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    campaignId,
    task.workflow_id,
    'meta',
    'social',
    'pending_approval',
    campaign.id,
    campaignName,
    now,
    now,
    JSON.stringify({
      meta_campaign_id: campaign.id,
      meta_adset_id: adSet.id,
      meta_creative_id: creative.id,
      meta_ad_id: ad.id,
      daily_budget_cents: dailyBudgetCents,
      asset_keys: task.asset_keys ?? [],
      input_tokens: copyResult.input_tokens,
      output_tokens: copyResult.output_tokens,
    })
  ).run();

  // 7. Publish approval request
  const approvalId = generateApprovalId();
  const correlationId = generateId();
  const timestamp = Date.now();
  const sig = await signMessage(
    buildSignaturePayload(task.workflow_id, correlationId, timestamp),
    env.QUEUE_SIGNING_KEY
  );

  await env.QUEUE_APPROVALS.send({
    workflow_id: task.workflow_id,
    correlation_id: correlationId,
    timestamp,
    signature: sig,
    approval_id: approvalId,
    agent: 'meta',
    action_type: 'activate_meta_campaign',
    payload: {
      meta_campaign_id: campaign.id,
      meta_adset_id: adSet.id,
      meta_ad_id: ad.id,
      campaign_id: campaignId,
    },
    preview_url: `https://marketing.angelcosmetics.com/campaigns/${campaignId}`,
    campaign_id: campaignId,
  });

  logger.info('Meta campaign created (PAUSED) and approval requested', {
    workflow_id: task.workflow_id,
    approval_id: approvalId,
    model: copyResult.model,
    input_tokens: copyResult.input_tokens,
    output_tokens: copyResult.output_tokens,
    external_api: 'meta',
    external_api_status: 200,
  });

  return {
    campaign_id: campaignId,
    meta_campaign_id: campaign.id,
    meta_adset_id: adSet.id,
    meta_ad_id: ad.id,
    approval_id: approvalId,
    campaign_name: campaignName,
  };
}

// ─── Fetch insights ───────────────────────────────────────────────────────────

async function fetchMetaInsights(
  task: MetaTask,
  _env: MetaAgentEnv,
  clients: { meta: MetaClient }
): Promise<Record<string, unknown>> {
  const insights = await clients.meta.getInsights('last_30_days');

  const totalSpend = insights.data.reduce((sum, c) => sum + parseFloat(c.spend || '0'), 0);
  const totalClicks = insights.data.reduce((sum, c) => sum + parseInt(c.clicks || '0', 10), 0);
  const totalImpressions = insights.data.reduce((sum, c) => sum + parseInt(c.impressions || '0', 10), 0);

  logger.info('Meta insights fetched', {
    workflow_id: task.workflow_id,
    external_api: 'meta',
    external_api_status: 200,
  });

  return {
    campaign_count: insights.data.length,
    total_spend: totalSpend.toFixed(2),
    total_clicks: totalClicks,
    total_impressions: totalImpressions,
    avg_ctr: totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) + '%' : '0%',
    campaigns: insights.data,
  };
}
