// ─── Email Marketing Agent Worker ────────────────────────────────────────────
// Responsibilities:
//   - Draft Mailchimp campaigns (HTML content, subject lines)
//   - Use GPT-4o for email copywriting
//   - Create DRAFT campaigns in Mailchimp (status: draft only)
//   - Request human approval before any send/schedule action
//   - NEVER calls /campaigns/{id}/actions/send or /actions/schedule

import { MailchimpClient } from '../../lib/clients/mailchimp';
import { OpenAIClient } from '../../lib/clients/openai';
import { Logger } from '../../lib/utils/logger';
import { generateCampaignId, generateApprovalId, generateId } from '../../lib/utils/id';
import { signMessage, buildSignaturePayload, verifySignature } from '../../lib/utils/signing';
import { ModelRouter } from '../../lib/utils/model-router';
import type { EmailTask } from '../../lib/queues/schemas';

export interface EmailAgentEnv {
  QUEUE_RESULTS: Queue;
  QUEUE_APPROVALS: Queue;
  QUEUE_CREATIVE: Queue;
  DB: D1Database;
  KV_CONFIG: KVNamespace;
  KV_CACHE: KVNamespace;
  R2_EXPORTS: R2Bucket;
  // Secrets
  OPENAI_API_KEY: string;
  MAILCHIMP_API_KEY: string;
  MAILCHIMP_SERVER_PREFIX: string;
  MAILCHIMP_FROM_NAME: string;
  MAILCHIMP_REPLY_TO: string;
  QUEUE_SIGNING_KEY: string;
  INTERNAL_API_KEY: string;
  MOCK_EXTERNAL_APIS: string;
}

const logger = new Logger('email');

export default {
  async fetch(_request: Request, _env: EmailAgentEnv): Promise<Response> {
    return new Response(JSON.stringify({ status: 'ok', service: 'agent-email' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },

  async queue(batch: MessageBatch<EmailTask>, env: EmailAgentEnv): Promise<void> {
    const isMock = env.MOCK_EXTERNAL_APIS === 'true';
    const mailchimp = new MailchimpClient(env.MAILCHIMP_API_KEY, env.MAILCHIMP_SERVER_PREFIX, isMock);
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

        const result = await processEmailTask(task, env, { mailchimp, openai, modelRouter });

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
          agent: 'email',
          status: 'success',
          data: result,
          approval_id: result.approval_id,
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

// ─── Task processing ──────────────────────────────────────────────────────────

async function processEmailTask(
  task: EmailTask,
  env: EmailAgentEnv,
  clients: { mailchimp: MailchimpClient; openai: OpenAIClient; modelRouter: ModelRouter }
): Promise<Record<string, unknown>> {
  // 1. Get audience lists from Mailchimp
  const listsResponse = await clients.mailchimp.getLists();
  const audienceId = task.audience_id === 'default'
    ? listsResponse.lists[0]?.id
    : task.audience_id;

  if (!audienceId) throw new Error('No Mailchimp audience list found');

  // 2. Generate email copy with GPT-4o
  const copyModel = await clients.modelRouter.getModel('email', 'draft_copy');
  const copyResult = await clients.openai.complete({
    model: copyModel.model as string,
    messages: [
      {
        role: 'system',
        content: `You are the email marketing copywriter for Angel Cosmetics, a premium cosmetics brand.
Write persuasive, on-brand email content. Use feminine, empowering language.
Brand values: clean beauty, vegan, cruelty-free, luxurious but accessible.
Always output valid JSON only.`,
      },
      {
        role: 'user',
        content: `Write an email campaign for Angel Cosmetics.
Campaign name: ${task.campaign_name}
${task.analytics_context ? `Performance context: avg open rate ${task.analytics_context.avg_open_rate}%, top products: ${task.analytics_context.top_products.join(', ')}` : ''}
${task.asset_keys?.length ? `Product images are available at keys: ${task.asset_keys.join(', ')}` : ''}

Output JSON with these fields:
{
  "subject_line": "...",
  "preview_text": "...",
  "headline": "...",
  "body_html": "...",
  "cta_text": "...",
  "cta_url": "https://angelcosmetics.com/",
  "send_time_suggestions": ["ISO8601", "ISO8601", "ISO8601"]
}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.75,
  });

  const emailCopy = JSON.parse(copyResult.content) as {
    subject_line: string;
    preview_text: string;
    headline: string;
    body_html: string;
    cta_text: string;
    cta_url: string;
    send_time_suggestions: string[];
  };

  // 3. Generate subject line variants with GPT-4o-mini (cost optimisation)
  const subjectModel = await clients.modelRouter.getModel('email', 'subject_lines');
  const subjectResult = await clients.openai.complete({
    model: subjectModel.model as string,
    messages: [
      {
        role: 'system',
        content: 'You are a subject line specialist for Angel Cosmetics. Output JSON only.',
      },
      {
        role: 'user',
        content: `Generate 3 A/B test subject line variants for this campaign: "${task.campaign_name}"
Primary subject: "${emailCopy.subject_line}"
Output JSON: { "variants": ["...", "...", "..."] }`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.8,
  });

  const subjectVariants = JSON.parse(subjectResult.content) as { variants: string[] };

  // 4. Build full HTML email
  const htmlContent = buildEmailHtml({
    headline: emailCopy.headline,
    bodyHtml: emailCopy.body_html,
    ctaText: emailCopy.cta_text,
    ctaUrl: emailCopy.cta_url,
    assetKeys: task.asset_keys ?? [],
  });

  // 5. Create DRAFT campaign in Mailchimp (never sends or schedules)
  const campaign = await clients.mailchimp.createDraftCampaign({
    type: 'regular',
    recipients: { list_id: audienceId },
    settings: {
      subject_line: emailCopy.subject_line,
      preview_text: emailCopy.preview_text,
      title: task.campaign_name,
      from_name: env.MAILCHIMP_FROM_NAME ?? 'Angel Cosmetics',
      reply_to: env.MAILCHIMP_REPLY_TO ?? 'hello@angelcosmetics.com',
    },
  });

  await clients.mailchimp.setCampaignContent(campaign.id, { html: htmlContent });

  // 6. Store HTML in R2
  const r2Key = `content/email/${task.workflow_id}/${campaign.id}.html`;
  await env.R2_EXPORTS.put(r2Key, htmlContent, {
    httpMetadata: { contentType: 'text/html' },
  });

  // 7. Record campaign in D1
  const campaignId = generateCampaignId('email');
  await env.DB.prepare(
    'INSERT INTO campaigns (id, workflow_id, agent, type, status, external_id, name, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    campaignId,
    task.workflow_id,
    'email',
    'email',
    'pending_approval',
    campaign.id,
    task.campaign_name,
    Math.floor(Date.now() / 1000),
    Math.floor(Date.now() / 1000),
    JSON.stringify({
      subject_line: emailCopy.subject_line,
      subject_variants: subjectVariants.variants,
      send_time_suggestions: emailCopy.send_time_suggestions,
      mailchimp_campaign_id: campaign.id,
      r2_key: r2Key,
      input_tokens: copyResult.input_tokens + subjectResult.input_tokens,
      output_tokens: copyResult.output_tokens + subjectResult.output_tokens,
    })
  ).run();

  // 8. Publish approval request
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
    agent: 'email',
    action_type: 'send_email',
    payload: {
      mailchimp_campaign_id: campaign.id,
      send_time: emailCopy.send_time_suggestions[0],
      campaign_id: campaignId,
    },
    preview_url: `https://marketing.angelcosmetics.com/campaigns/${campaignId}`,
    campaign_id: campaignId,
  });

  logger.info('Email draft created and approval requested', {
    workflow_id: task.workflow_id,
    approval_id: approvalId,
    model: copyResult.model,
    input_tokens: copyResult.input_tokens,
    output_tokens: copyResult.output_tokens,
    external_api: 'mailchimp',
    external_api_status: 200,
  });

  return {
    campaign_id: campaignId,
    mailchimp_campaign_id: campaign.id,
    approval_id: approvalId,
    r2_key: r2Key,
    subject_line: emailCopy.subject_line,
  };
}

// ─── HTML email builder ───────────────────────────────────────────────────────

function buildEmailHtml(params: {
  headline: string;
  bodyHtml: string;
  ctaText: string;
  ctaUrl: string;
  assetKeys: string[];
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Angel Cosmetics</title>
  <style>
    body { font-family: Georgia, serif; background: #faf9f7; margin: 0; padding: 0; color: #2c2c2c; }
    .container { max-width: 600px; margin: 0 auto; background: #ffffff; }
    .header { background: #1a1a1a; padding: 24px; text-align: center; }
    .header img { height: 40px; }
    .hero { padding: 40px 32px; }
    h1 { font-size: 28px; font-weight: 400; color: #1a1a1a; line-height: 1.3; margin: 0 0 16px; }
    .body { padding: 0 32px 24px; font-size: 16px; line-height: 1.7; }
    .cta-wrapper { padding: 16px 32px 40px; text-align: center; }
    .cta { display: inline-block; background: #1a1a1a; color: #ffffff !important; text-decoration: none; padding: 14px 32px; font-size: 14px; letter-spacing: 1px; text-transform: uppercase; }
    .footer { background: #f5f5f5; padding: 24px 32px; font-size: 12px; color: #888; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span style="color:#ffffff;font-size:20px;letter-spacing:3px;font-weight:300;">ANGEL COSMETICS</span>
    </div>
    <div class="hero">
      <h1>${escapeHtml(params.headline)}</h1>
    </div>
    ${params.assetKeys.length > 0
      ? `<div style="padding:0 32px;"><img src="{{asset_url}}" alt="Angel Cosmetics" style="width:100%;max-width:536px;" /></div>`
      : ''}
    <div class="body">${params.bodyHtml}</div>
    <div class="cta-wrapper">
      <a href="${params.ctaUrl}" class="cta">${escapeHtml(params.ctaText)}</a>
    </div>
    <div class="footer">
      <p>Angel Cosmetics · Clean Beauty, Vegan &amp; Cruelty-Free</p>
      <p><a href="*|UNSUB|*" style="color:#888;">Unsubscribe</a></p>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
