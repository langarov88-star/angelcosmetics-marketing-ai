// ─── Analytics Agent Worker ───────────────────────────────────────────────────
// Responsibilities:
//   - Fetch campaign performance from Mailchimp, Google Ads, and Meta
//   - Aggregate cross-channel metrics (spend, clicks, impressions, conversions)
//   - Synthesise narrative performance reports via GPT-4o / Gemini 1.5 Pro
//   - Store HTML reports in R2 and notify the orchestrator
//   - Read-only access to all external advertising APIs — no write operations

import { MailchimpClient } from '../../lib/clients/mailchimp';
import { GoogleAdsClient } from '../../lib/clients/google-ads';
import { MetaClient } from '../../lib/clients/meta';
import { OpenAIClient } from '../../lib/clients/openai';
import { GeminiClient } from '../../lib/clients/gemini';
import { Logger } from '../../lib/utils/logger';
import { generateId } from '../../lib/utils/id';
import { signMessage, buildSignaturePayload, verifySignature } from '../../lib/utils/signing';
import { ModelRouter } from '../../lib/utils/model-router';
import type { AnalyticsTask } from '../../lib/queues/schemas';

export interface AnalyticsAgentEnv {
  QUEUE_RESULTS: Queue;
  QUEUE_NOTIFICATIONS: Queue;
  DB: D1Database;
  KV_CONFIG: KVNamespace;
  KV_CACHE: KVNamespace;
  R2_EXPORTS: R2Bucket;
  // Secrets
  OPENAI_API_KEY: string;
  GEMINI_API_KEY: string;
  MAILCHIMP_API_KEY: string;
  MAILCHIMP_SERVER_PREFIX: string;
  GOOGLE_ADS_DEVELOPER_TOKEN: string;
  GOOGLE_ADS_CLIENT_ID: string;
  GOOGLE_ADS_CLIENT_SECRET: string;
  GOOGLE_ADS_REFRESH_TOKEN: string;
  GOOGLE_ADS_CUSTOMER_ID: string;
  META_ACCESS_TOKEN: string;
  META_AD_ACCOUNT_ID: string;
  QUEUE_SIGNING_KEY: string;
  INTERNAL_API_KEY: string;
  MOCK_EXTERNAL_APIS: string;
}

const logger = new Logger('analytics');

export default {
  async fetch(_request: Request, _env: AnalyticsAgentEnv): Promise<Response> {
    return new Response(JSON.stringify({ status: 'ok', service: 'agent-analytics' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },

  async queue(batch: MessageBatch<AnalyticsTask>, env: AnalyticsAgentEnv): Promise<void> {
    const isMock = env.MOCK_EXTERNAL_APIS === 'true';
    const mailchimp = new MailchimpClient(env.MAILCHIMP_API_KEY, env.MAILCHIMP_SERVER_PREFIX, isMock);
    const googleAds = new GoogleAdsClient(env.GOOGLE_ADS_DEVELOPER_TOKEN, env.GOOGLE_ADS_CUSTOMER_ID, isMock);
    const meta = new MetaClient(env.META_ACCESS_TOKEN, env.META_AD_ACCOUNT_ID, isMock);
    const openai = new OpenAIClient(env.OPENAI_API_KEY, isMock);
    const gemini = new GeminiClient(env.GEMINI_API_KEY, isMock);
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

        switch (task.task) {
          case 'fetch_email_performance':
            result = await fetchEmailPerformance(task, env, { mailchimp });
            break;
          case 'fetch_ads_performance':
            result = await fetchAdsPerformance(task, env, { googleAds, meta });
            break;
          case 'monthly_report':
            result = await generateMonthlyReport(task, env, { mailchimp, googleAds, meta, openai, gemini, modelRouter });
            break;
          default:
            throw new Error(`Unknown analytics task: ${String(task.task)}`);
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
          agent: 'analytics',
          status: 'success',
          data: result,
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

// ─── Fetch email performance ──────────────────────────────────────────────────

async function fetchEmailPerformance(
  task: AnalyticsTask,
  _env: AnalyticsAgentEnv,
  clients: { mailchimp: MailchimpClient }
): Promise<Record<string, unknown>> {
  const reports = await clients.mailchimp.getCampaignReports();

  const recentReports = reports.reports.slice(0, 10);

  const totalSent = recentReports.reduce((sum, r) => sum + (r.emails_sent ?? 0), 0);
  const totalOpens = recentReports.reduce((sum, r) => sum + (r.opens?.unique_opens ?? 0), 0);
  const totalClicks = recentReports.reduce((sum, r) => sum + (r.clicks?.unique_subscriber_clicks ?? 0), 0);

  const avgOpenRate = totalSent > 0 ? ((totalOpens / totalSent) * 100) : 0;
  const avgClickRate = totalSent > 0 ? ((totalClicks / totalSent) * 100) : 0;

  // Find best-performing campaign by open rate
  const bestCampaign = recentReports.reduce(
    (best, r) => {
      const rate = r.emails_sent ? (r.opens?.unique_opens ?? 0) / r.emails_sent : 0;
      return rate > best.rate ? { campaign: r, rate } : best;
    },
    { campaign: recentReports[0], rate: 0 }
  );

  logger.info('Email performance fetched', {
    workflow_id: task.workflow_id,
    external_api: 'mailchimp',
    external_api_status: 200,
  });

  return {
    campaign_count: recentReports.length,
    total_sent: totalSent,
    avg_open_rate: avgOpenRate.toFixed(2),
    avg_click_rate: avgClickRate.toFixed(2),
    best_send_time: 'Tuesday 10:00 AM',  // Static recommendation; dynamic in Phase 2
    top_products: [],
    best_campaign_title: bestCampaign.campaign?.campaign_title ?? '',
    reports: recentReports.map((r) => ({
      id: r.id,
      title: r.campaign_title,
      emails_sent: r.emails_sent,
      open_rate: r.emails_sent ? ((r.opens?.unique_opens ?? 0) / r.emails_sent * 100).toFixed(2) : '0',
      click_rate: r.emails_sent ? ((r.clicks?.unique_subscriber_clicks ?? 0) / r.emails_sent * 100).toFixed(2) : '0',
    })),
  };
}

// ─── Fetch ads performance ────────────────────────────────────────────────────

async function fetchAdsPerformance(
  task: AnalyticsTask,
  env: AnalyticsAgentEnv,
  clients: { googleAds: GoogleAdsClient; meta: MetaClient }
): Promise<Record<string, unknown>> {
  // Fetch Google Ads data
  const googleAccessToken = await clients.googleAds.refreshAccessToken(
    env.GOOGLE_ADS_CLIENT_ID,
    env.GOOGLE_ADS_CLIENT_SECRET,
    env.GOOGLE_ADS_REFRESH_TOKEN,
    env.KV_CACHE
  );
  const googlePerformance = await clients.googleAds.getCampaignPerformance(googleAccessToken);

  // Fetch Meta data
  const metaInsights = await clients.meta.getInsights('last_30_days');

  // Aggregate Google Ads
  const googleSpendUsd = googlePerformance.reduce((sum, c) => sum + c.cost_micros / 1_000_000, 0);
  const googleClicks = googlePerformance.reduce((sum, c) => sum + c.clicks, 0);
  const googleImpressions = googlePerformance.reduce((sum, c) => sum + c.impressions, 0);
  const googleConversions = googlePerformance.reduce((sum, c) => sum + c.conversions, 0);

  // Aggregate Meta
  const metaSpend = metaInsights.data.reduce((sum, c) => sum + parseFloat(c.spend || '0'), 0);
  const metaClicks = metaInsights.data.reduce((sum, c) => sum + parseInt(c.clicks || '0', 10), 0);
  const metaImpressions = metaInsights.data.reduce((sum, c) => sum + parseInt(c.impressions || '0', 10), 0);

  logger.info('Ads performance fetched', {
    workflow_id: task.workflow_id,
    external_api: 'google-ads+meta',
    external_api_status: 200,
  });

  return {
    google_ads: {
      total_spend_usd: googleSpendUsd.toFixed(2),
      total_clicks: googleClicks,
      total_impressions: googleImpressions,
      total_conversions: googleConversions,
      avg_ctr: googleImpressions > 0 ? ((googleClicks / googleImpressions) * 100).toFixed(2) + '%' : '0%',
      campaigns: googlePerformance,
    },
    meta: {
      total_spend_usd: metaSpend.toFixed(2),
      total_clicks: metaClicks,
      total_impressions: metaImpressions,
      avg_ctr: metaImpressions > 0 ? ((metaClicks / metaImpressions) * 100).toFixed(2) + '%' : '0%',
      campaigns: metaInsights.data,
    },
    combined: {
      total_spend_usd: (googleSpendUsd + metaSpend).toFixed(2),
      total_clicks: googleClicks + metaClicks,
      total_impressions: googleImpressions + metaImpressions,
    },
  };
}

// ─── Monthly report ───────────────────────────────────────────────────────────

async function generateMonthlyReport(
  task: AnalyticsTask,
  env: AnalyticsAgentEnv,
  clients: {
    mailchimp: MailchimpClient;
    googleAds: GoogleAdsClient;
    meta: MetaClient;
    openai: OpenAIClient;
    gemini: GeminiClient;
    modelRouter: ModelRouter;
  }
): Promise<Record<string, unknown>> {
  const month = task.month ?? new Date().toISOString().slice(0, 7);

  // 1. Gather all data in parallel
  const [emailData, adsData] = await Promise.all([
    fetchEmailPerformance(task, env, { mailchimp: clients.mailchimp }),
    fetchAdsPerformance(task, env, { googleAds: clients.googleAds, meta: clients.meta }),
  ]);

  const combinedData = { email: emailData, ads: adsData, month };
  const dataJson = JSON.stringify(combinedData, null, 2);

  // 2. Synthesise narrative — use Gemini 1.5 Pro for large context data sets
  const reportModel = await clients.modelRouter.getModel('analytics', 'report_synthesis');
  const useGemini = (reportModel.model as string).includes('gemini');

  let narrative: string;
  let reportTokens = { input: 0, output: 0, model: '' };

  if (useGemini) {
    const geminiResult = await clients.gemini.complete({
      model: reportModel.model as 'gemini-1.5-pro' | 'gemini-2.0-flash',
      messages: [
        {
          role: 'user',
          parts: [
            {
              text: `Analyze this Angel Cosmetics marketing performance data for ${month} and write a concise executive report.

DATA:
${dataJson}

Include:
1. Executive Summary (3 sentences)
2. Email Marketing highlights (open rate, click rate, best campaign)
3. Paid Ads highlights (Google Ads + Meta: spend, top performers)
4. Key Wins this month
5. Areas for Improvement
6. Budget Recommendations for next month

Write in clear business language. Be specific with numbers.`,
            },
          ],
        },
      ],
      system_instruction: 'You are the Head of Marketing Analytics at Angel Cosmetics. Write data-driven, actionable performance reports.',
      temperature: 0.4,
    });
    narrative = geminiResult.content;
    reportTokens = { input: geminiResult.input_tokens, output: geminiResult.output_tokens, model: geminiResult.model };
  } else {
    const openaiResult = await clients.openai.complete({
      model: reportModel.model as string,
      messages: [
        {
          role: 'system',
          content: 'You are the Head of Marketing Analytics at Angel Cosmetics. Write data-driven, actionable performance reports.',
        },
        {
          role: 'user',
          content: `Analyze this Angel Cosmetics marketing performance data for ${month} and write a concise executive report.

DATA:
${dataJson}

Include:
1. Executive Summary (3 sentences)
2. Email Marketing highlights
3. Paid Ads highlights
4. Key Wins this month
5. Areas for Improvement
6. Budget Recommendations for next month

Be specific with numbers.`,
        },
      ],
      temperature: 0.4,
    });
    narrative = openaiResult.content;
    reportTokens = { input: openaiResult.input_tokens, output: openaiResult.output_tokens, model: openaiResult.model };
  }

  // 3. Build HTML report
  const htmlReport = buildReportHtml({ month, narrative, emailData, adsData });

  // 4. Store in R2
  const r2Key = `reports/${month}.html`;
  await env.R2_EXPORTS.put(r2Key, htmlReport, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
    customMetadata: { workflow_id: task.workflow_id, month },
  });

  // 5. Publish notification
  await env.QUEUE_NOTIFICATIONS.send({
    type: 'report_ready',
    workflow_id: task.workflow_id,
    title: `Monthly Performance Report — ${month}`,
    body: `Your Angel Cosmetics marketing report for ${month} is ready. Click to view.`,
    action_url: `https://marketing.angelcosmetics.com/reports/${month}`,
    severity: 'info',
    channels: ['slack', 'email'],
  });

  logger.info('Monthly report generated', {
    workflow_id: task.workflow_id,
    model: reportTokens.model,
    input_tokens: reportTokens.input,
    output_tokens: reportTokens.output,
    external_api: 'mailchimp+google-ads+meta',
    external_api_status: 200,
  });

  return {
    month,
    r2_key: r2Key,
    report_url: `https://marketing.angelcosmetics.com/reports/${month}`,
    summary: {
      email_campaigns: emailData.campaign_count,
      avg_email_open_rate: emailData.avg_open_rate,
      total_ad_spend_usd: (adsData as { combined: { total_spend_usd: string } }).combined.total_spend_usd,
    },
  };
}

// ─── HTML report builder ──────────────────────────────────────────────────────

function buildReportHtml(params: {
  month: string;
  narrative: string;
  emailData: Record<string, unknown>;
  adsData: Record<string, unknown>;
}): string {
  const combined = params.adsData.combined as { total_spend_usd: string; total_clicks: number };
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Angel Cosmetics — Marketing Report ${params.month}</title>
  <style>
    body { font-family: Georgia, serif; background: #faf9f7; color: #2c2c2c; max-width: 800px; margin: 40px auto; padding: 0 24px; }
    h1 { font-size: 28px; font-weight: 400; border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; }
    h2 { font-size: 18px; font-weight: 600; margin-top: 32px; color: #1a1a1a; }
    .metric { display: inline-block; background: #f5f5f5; padding: 12px 20px; margin: 8px; border-left: 3px solid #1a1a1a; }
    .metric-value { font-size: 24px; font-weight: 700; display: block; }
    .metric-label { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
    .narrative { line-height: 1.8; white-space: pre-wrap; }
    .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #ddd; font-size: 12px; color: #888; }
  </style>
</head>
<body>
  <h1>ANGEL COSMETICS<br><small style="font-size:16px;color:#888;">Marketing Performance Report — ${params.month}</small></h1>

  <h2>Key Metrics</h2>
  <div>
    <div class="metric">
      <span class="metric-value">${params.emailData.avg_open_rate as string}%</span>
      <span class="metric-label">Avg Email Open Rate</span>
    </div>
    <div class="metric">
      <span class="metric-value">${params.emailData.avg_click_rate as string}%</span>
      <span class="metric-label">Avg Email Click Rate</span>
    </div>
    <div class="metric">
      <span class="metric-value">$${combined.total_spend_usd}</span>
      <span class="metric-label">Total Ad Spend</span>
    </div>
    <div class="metric">
      <span class="metric-value">${combined.total_clicks.toLocaleString()}</span>
      <span class="metric-label">Total Paid Clicks</span>
    </div>
  </div>

  <h2>Analysis &amp; Recommendations</h2>
  <div class="narrative">${escapeHtml(params.narrative)}</div>

  <div class="footer">
    <p>Generated by Angel Cosmetics AI Marketing System · ${new Date().toISOString()}</p>
    <p>This report was automatically generated. Please review before sharing externally.</p>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
