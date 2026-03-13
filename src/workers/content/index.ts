// ─── Content / SEO Agent Worker ───────────────────────────────────────────────
// Responsibilities:
//   - Draft SEO-optimised blog posts using Gemini (research) + GPT-4o (writing)
//   - Draft product descriptions using GPT-4o-mini
//   - Store drafts in R2 as Markdown files
//   - Request human approval before any content is published to CMS
//   - NEVER publishes directly to any CMS or storefront

import { GeminiClient } from '../../lib/clients/gemini';
import { OpenAIClient } from '../../lib/clients/openai';
import { Logger } from '../../lib/utils/logger';
import { generateCampaignId, generateApprovalId, generateId } from '../../lib/utils/id';
import { signMessage, buildSignaturePayload, verifySignature } from '../../lib/utils/signing';
import { ModelRouter } from '../../lib/utils/model-router';
import type { ContentTask } from '../../lib/queues/schemas';

export interface ContentAgentEnv {
  QUEUE_RESULTS: Queue;
  QUEUE_APPROVALS: Queue;
  DB: D1Database;
  KV_CONFIG: KVNamespace;
  KV_CACHE: KVNamespace;
  R2_EXPORTS: R2Bucket;
  // Secrets
  OPENAI_API_KEY: string;
  GEMINI_API_KEY: string;
  QUEUE_SIGNING_KEY: string;
  INTERNAL_API_KEY: string;
  MOCK_EXTERNAL_APIS: string;
}

const logger = new Logger('content');

export default {
  async fetch(_request: Request, _env: ContentAgentEnv): Promise<Response> {
    return new Response(JSON.stringify({ status: 'ok', service: 'agent-content' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },

  async queue(batch: MessageBatch<ContentTask>, env: ContentAgentEnv): Promise<void> {
    const isMock = env.MOCK_EXTERNAL_APIS === 'true';
    const gemini = new GeminiClient(env.GEMINI_API_KEY, isMock);
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

        if (task.task === 'draft_blog_post') {
          result = await draftBlogPost(task, env, { gemini, openai, modelRouter });
        } else {
          result = await draftProductDescription(task, env, { openai, modelRouter });
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
          agent: 'content',
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

// ─── Draft blog post ──────────────────────────────────────────────────────────

async function draftBlogPost(
  task: ContentTask,
  env: ContentAgentEnv,
  clients: { gemini: GeminiClient; openai: OpenAIClient; modelRouter: ModelRouter }
): Promise<Record<string, unknown>> {
  const wordCount = task.word_count ?? 1200;
  const slug = task.target_keyword.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  // 1. Research phase: use Gemini with web search grounding
  const researchModel = await clients.modelRouter.getModel('content', 'research');
  const researchResult = await clients.gemini.complete({
    model: researchModel.model as 'gemini-1.5-pro' | 'gemini-2.0-flash',
    messages: [
      {
        role: 'user',
        parts: [
          {
            text: `Research the topic "${task.target_keyword}" for a cosmetics beauty blog.
Identify: top search intent, key talking points from top-ranking content, relevant sub-topics,
and 5 long-tail keyword variations. Summarize findings in 300 words.`,
          },
        ],
      },
    ],
    system_instruction: 'You are an SEO research analyst for Angel Cosmetics, a premium vegan beauty brand. Provide factual, research-based summaries.',
    temperature: 0.3,
    enable_grounding: true,
  });

  // 2. Draft phase: use GPT-4o for final quality copy
  const draftModel = await clients.modelRouter.getModel('content', 'draft_post');
  const draftResult = await clients.openai.complete({
    model: draftModel.model as string,
    messages: [
      {
        role: 'system',
        content: `You are the lead content writer for Angel Cosmetics, a premium vegan cosmetics brand.
Write SEO-optimised blog posts that are authoritative, engaging, and on-brand.
Brand voice: expert, empowering, clean, sustainable beauty-focused.
Format output as Markdown with proper H2/H3 headings, short paragraphs, and a clear CTA at the end.`,
      },
      {
        role: 'user',
        content: `Write a ${wordCount}-word blog post targeting the keyword: "${task.target_keyword}"

Research context:
${researchResult.content}

${task.product_id ? `Feature product ID: ${task.product_id}` : ''}

Include:
- SEO title (60 chars max)
- Meta description (155 chars max)
- Introduction that hooks the reader
- 3-4 main sections with H2 headings
- Internal link placeholders: [LINK: product page], [LINK: related article]
- CTA section linking to angelcosmetics.com

Output full Markdown document.`,
      },
    ],
    temperature: 0.7,
  });

  // 3. Store in R2
  const timestamp = Date.now();
  const r2Key = `content/${task.workflow_id}/blog-${slug}-${timestamp}.md`;
  const markdownContent = draftResult.content;

  await env.R2_EXPORTS.put(r2Key, markdownContent, {
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
    customMetadata: {
      workflow_id: task.workflow_id,
      target_keyword: task.target_keyword,
      word_count: String(wordCount),
    },
  });

  // 4. Write campaign record to D1
  const campaignId = generateCampaignId('content');
  const now = Math.floor(timestamp / 1000);
  await env.DB.prepare(
    'INSERT INTO campaigns (id, workflow_id, agent, type, status, external_id, name, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    campaignId,
    task.workflow_id,
    'content',
    'blog_post',
    'pending_approval',
    r2Key,
    `Blog: ${task.target_keyword}`,
    now,
    now,
    JSON.stringify({
      target_keyword: task.target_keyword,
      slug,
      r2_key: r2Key,
      word_count: wordCount,
      research_tokens: researchResult.input_tokens + researchResult.output_tokens,
      draft_tokens: draftResult.input_tokens + draftResult.output_tokens,
    })
  ).run();

  // 5. Publish approval request
  const approvalId = generateApprovalId();
  const correlationId = generateId();
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
    agent: 'content',
    action_type: 'publish_content',
    payload: {
      r2_key: r2Key,
      content_type: 'blog_post',
      slug,
      campaign_id: campaignId,
    },
    preview_url: `https://marketing.angelcosmetics.com/campaigns/${campaignId}`,
    campaign_id: campaignId,
  });

  logger.info('Blog post drafted and approval requested', {
    workflow_id: task.workflow_id,
    approval_id: approvalId,
    model: draftResult.model,
    input_tokens: draftResult.input_tokens + researchResult.input_tokens,
    output_tokens: draftResult.output_tokens + researchResult.output_tokens,
    external_api: 'openai+gemini',
    external_api_status: 200,
  });

  return {
    campaign_id: campaignId,
    r2_key: r2Key,
    approval_id: approvalId,
    slug,
    target_keyword: task.target_keyword,
  };
}

// ─── Draft product description ────────────────────────────────────────────────

async function draftProductDescription(
  task: ContentTask,
  env: ContentAgentEnv,
  clients: { openai: OpenAIClient; modelRouter: ModelRouter }
): Promise<Record<string, unknown>> {
  // Use GPT-4o-mini for cost efficiency on shorter structured tasks
  const model = await clients.modelRouter.getModel('content', 'product_descriptions');
  const result = await clients.openai.complete({
    model: model.model as string,
    messages: [
      {
        role: 'system',
        content: `You are a product copywriter for Angel Cosmetics, a premium vegan beauty brand.
Write compelling product descriptions that are SEO-friendly and conversion-optimised.
Always highlight: clean ingredients, vegan/cruelty-free status, key benefits, usage instructions.
Output valid JSON only.`,
      },
      {
        role: 'user',
        content: `Write a product description for keyword: "${task.target_keyword}"
${task.product_id ? `Product ID: ${task.product_id}` : ''}

Output JSON:
{
  "short_description": "60-100 word teaser for product listings",
  "long_description": "200-300 word full description with benefits and usage",
  "meta_title": "SEO title ≤60 chars",
  "meta_description": "SEO description ≤155 chars",
  "bullet_points": ["benefit 1", "benefit 2", "benefit 3", "benefit 4", "benefit 5"]
}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.65,
  });

  const description = JSON.parse(result.content) as {
    short_description: string;
    long_description: string;
    meta_title: string;
    meta_description: string;
    bullet_points: string[];
  };

  // Store in R2 as Markdown
  const timestamp = Date.now();
  const slug = (task.product_id ?? task.target_keyword).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const r2Key = `content/${task.workflow_id}/product-${slug}-${timestamp}.md`;

  const markdownContent = `# ${description.meta_title}

**Meta description:** ${description.meta_description}

## Short Description

${description.short_description}

## Full Description

${description.long_description}

## Key Benefits

${description.bullet_points.map((b) => `- ${b}`).join('\n')}
`;

  await env.R2_EXPORTS.put(r2Key, markdownContent, {
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
    customMetadata: {
      workflow_id: task.workflow_id,
      product_id: task.product_id ?? '',
      target_keyword: task.target_keyword,
    },
  });

  // Write D1 record
  const campaignId = generateCampaignId('content');
  const now = Math.floor(timestamp / 1000);
  await env.DB.prepare(
    'INSERT INTO campaigns (id, workflow_id, agent, type, status, external_id, name, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    campaignId,
    task.workflow_id,
    'content',
    'product_description',
    'pending_approval',
    r2Key,
    `Product: ${task.target_keyword}`,
    now,
    now,
    JSON.stringify({
      target_keyword: task.target_keyword,
      product_id: task.product_id,
      r2_key: r2Key,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
    })
  ).run();

  // Publish approval request
  const approvalId = generateApprovalId();
  const correlationId = generateId();
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
    agent: 'content',
    action_type: 'publish_content',
    payload: {
      r2_key: r2Key,
      content_type: 'product_description',
      product_id: task.product_id,
      campaign_id: campaignId,
    },
    preview_url: `https://marketing.angelcosmetics.com/campaigns/${campaignId}`,
    campaign_id: campaignId,
  });

  logger.info('Product description drafted and approval requested', {
    workflow_id: task.workflow_id,
    approval_id: approvalId,
    model: result.model,
    input_tokens: result.input_tokens,
    output_tokens: result.output_tokens,
    external_api: 'openai',
    external_api_status: 200,
  });

  return {
    campaign_id: campaignId,
    r2_key: r2Key,
    approval_id: approvalId,
    product_id: task.product_id,
    target_keyword: task.target_keyword,
  };
}
