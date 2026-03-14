// ─── Google Ads Agent Worker ──────────────────────────────────────────────────
// Responsibilities:
//   - Generate responsive search ad copy (headlines + descriptions) via GPT-4o
//   - Create campaigns/ad groups/ads in Google Ads with status PAUSED
//   - Fetch campaign performance data for the orchestrator
//   - Request human approval before any campaign activation
//   - NEVER sets campaign status to ENABLED (only approval-service can do that)

import { GoogleAdsClient } from '../../lib/clients/google-ads';
import { OpenAIClient } from '../../lib/clients/openai';
import { Logger } from '../../lib/utils/logger';
import { generateCampaignId, generateApprovalId, generateId } from '../../lib/utils/id';
import { signMessage, buildSignaturePayload, verifySignature } from '../../lib/utils/signing';
import { ModelRouter } from '../../lib/utils/model-router';
import type { GoogleAdsTask } from '../../lib/queues/schemas';

export interface GoogleAdsAgentEnv {
  QUEUE_RESULTS: Queue;
  QUEUE_APPROVALS: Queue;
  DB: D1Database;
  KV_CONFIG: KVNamespace;
  KV_CACHE: KVNamespace;
  // Secrets
  OPENAI_API_KEY: string;
  GOOGLE_ADS_DEVELOPER_TOKEN: string;
  GOOGLE_ADS_CLIENT_ID: string;
  GOOGLE_ADS_CLIENT_SECRET: string;
  GOOGLE_ADS_REFRESH_TOKEN: string;
  GOOGLE_ADS_CUSTOMER_ID: string;
  QUEUE_SIGNING_KEY: string;
  INTERNAL_API_KEY: string;
  MOCK_EXTERNAL_APIS: string;
}

const logger = new Logger('google-ads');

export default {
  async fetch(_request: Request, _env: GoogleAdsAgentEnv): Promise<Response> {
    return new Response(JSON.stringify({ status: 'ok', service: 'agent-google-ads' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },

  async queue(batch: MessageBatch<GoogleAdsTask>, env: GoogleAdsAgentEnv): Promise<void> {
    const isMock = env.MOCK_EXTERNAL_APIS === 'true';
    const googleAds = new GoogleAdsClient(env.GOOGLE_ADS_DEVELOPER_TOKEN, env.GOOGLE_ADS_CUSTOMER_ID, isMock);
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
          result = await createGoogleAdsCampaign(task, env, { googleAds, openai, modelRouter });
        } else {
          result = await fetchGoogleAdsPerformance(task, env, { googleAds });
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
          agent: 'google-ads',
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

async function createGoogleAdsCampaign(
  task: GoogleAdsTask,
  env: GoogleAdsAgentEnv,
  clients: { googleAds: GoogleAdsClient; openai: OpenAIClient; modelRouter: ModelRouter }
): Promise<Record<string, unknown>> {
  const campaignName = task.campaign_name ?? `Angel Cosmetics — ${new Date().toISOString().slice(0, 10)}`;
  const dailyBudgetMicros = task.daily_budget_micros ?? 5_000_000; // $5 default

  // 1. Get OAuth access token (cached in KV)
  const accessToken = await clients.googleAds.refreshAccessToken(
    env.GOOGLE_ADS_CLIENT_ID,
    env.GOOGLE_ADS_CLIENT_SECRET,
    env.GOOGLE_ADS_REFRESH_TOKEN,
    env.KV_CACHE
  );

  // 2. Generate ad copy with GPT-4o
  const adCopyModel = await clients.modelRouter.getModel('google-ads', 'ad_copy');
  const copyResult = await clients.openai.complete({
    model: adCopyModel.model as string,
    messages: [
      {
        role: 'system',
        content: `You are a Google Ads specialist for Angel Cosmetics, a premium vegan cosmetics brand.
Write compelling responsive search ad copy. Follow Google Ads character limits strictly:
- Headlines: max 30 characters each
- Descriptions: max 90 characters each
Output valid JSON only.`,
      },
      {
        role: 'user',
        content: `Create Google Ads copy for: "${campaignName}"
${task.product_id ? `Product ID: ${task.product_id}` : ''}
${task.keywords?.length ? `Target keywords: ${task.keywords.join(', ')}` : ''}

Output JSON:
{
  "headlines": ["...", "...", "...", "...", "...", "...", "...", "...", "...", "...", "...", "...", "...", "...", "..."],
  "descriptions": ["...", "...", "...", "..."],
  "final_url": "https://angelcosmetics.com/"
}
All 15 headlines must be ≤30 chars. All 4 descriptions must be ≤90 chars.`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7,
  });

  const adCopy = JSON.parse(copyResult.content) as {
    headlines: string[];
    descriptions: string[];
    final_url: string;
  };

  // 3. Create campaign (PAUSED)
  const campaign = await clients.googleAds.createCampaign(
    {
      name: campaignName,
      status: 'PAUSED',
      advertisingChannelType: 'SEARCH',
      campaignBudget: `customers/${env.GOOGLE_ADS_CUSTOMER_ID}/campaignBudgets/~1`,
      biddingStrategyType: 'MAXIMIZE_CONVERSIONS',
      dailyBudgetMicros,
    },
    accessToken
  );

  // 4. Create ad group (PAUSED)
  const adGroup = await clients.googleAds.createAdGroup(
    {
      campaign: campaign.resourceName,
      name: `${campaignName} — Ad Group 1`,
      status: 'PAUSED',
      type: 'SEARCH_STANDARD',
    },
    accessToken
  );

  // 5. Create responsive search ad (PAUSED)
  const ad = await clients.googleAds.createResponsiveSearchAd(
    {
      adGroup: adGroup.resourceName,
      ad: {
        responsiveSearchAd: {
          headlines: adCopy.headlines.slice(0, 15).map((text) => ({ text })),
          descriptions: adCopy.descriptions.slice(0, 4).map((text) => ({ text })),
          finalUrls: [adCopy.final_url],
        },
        finalUrls: [adCopy.final_url],
      },
      status: 'PAUSED',
    },
    accessToken
  );

  // 6. Write campaign record to D1
  const campaignId = generateCampaignId('google-ads');
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    'INSERT INTO campaigns (id, workflow_id, agent, type, status, external_id, name, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    campaignId,
    task.workflow_id,
    'google-ads',
    'search',
    'pending_approval',
    campaign.resourceName,
    campaignName,
    now,
    now,
    JSON.stringify({
      campaign_resource: campaign.resourceName,
      ad_group_resource: adGroup.resourceName,
      ad_resource: ad.resourceName,
      daily_budget_micros: dailyBudgetMicros,
      keywords: task.keywords ?? [],
      headline_count: adCopy.headlines.length,
      description_count: adCopy.descriptions.length,
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
    agent: 'google-ads',
    action_type: 'enable_google_campaign',
    payload: {
      campaign_resource_name: campaign.resourceName,
      campaign_id: campaignId,
      customer_id: env.GOOGLE_ADS_CUSTOMER_ID,
    },
    preview_url: `https://marketing.angelcosmetics.com/campaigns/${campaignId}`,
    campaign_id: campaignId,
  });

  logger.info('Google Ads campaign created (PAUSED) and approval requested', {
    workflow_id: task.workflow_id,
    approval_id: approvalId,
    model: copyResult.model,
    input_tokens: copyResult.input_tokens,
    output_tokens: copyResult.output_tokens,
    external_api: 'google-ads',
    external_api_status: 200,
  });

  return {
    campaign_id: campaignId,
    campaign_resource: campaign.resourceName,
    approval_id: approvalId,
    campaign_name: campaignName,
  };
}

// ─── Fetch performance ────────────────────────────────────────────────────────

async function fetchGoogleAdsPerformance(
  task: GoogleAdsTask,
  env: GoogleAdsAgentEnv,
  clients: { googleAds: GoogleAdsClient }
): Promise<Record<string, unknown>> {
  const accessToken = await clients.googleAds.refreshAccessToken(
    env.GOOGLE_ADS_CLIENT_ID,
    env.GOOGLE_ADS_CLIENT_SECRET,
    env.GOOGLE_ADS_REFRESH_TOKEN,
    env.KV_CACHE
  );

  const performance = await clients.googleAds.getCampaignPerformance(accessToken);

  const totalSpendMicros = performance.reduce((sum, c) => sum + c.cost_micros, 0);
  const totalClicks = performance.reduce((sum, c) => sum + c.clicks, 0);
  const totalImpressions = performance.reduce((sum, c) => sum + c.impressions, 0);
  const totalConversions = performance.reduce((sum, c) => sum + c.conversions, 0);

  logger.info('Google Ads performance fetched', {
    workflow_id: task.workflow_id,
    external_api: 'google-ads',
    external_api_status: 200,
  });

  return {
    campaign_count: performance.length,
    total_spend_micros: totalSpendMicros,
    total_clicks: totalClicks,
    total_impressions: totalImpressions,
    total_conversions: totalConversions,
    avg_ctr: totalImpressions > 0 ? (totalClicks / totalImpressions) : 0,
    campaigns: performance,
  };
}
