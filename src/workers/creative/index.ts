// ─── Creative / Visual Agent Worker ──────────────────────────────────────────
// Responsibilities:
//   - Generate detailed image generation prompts via Gemini 2.0 Flash
//   - Generate product/campaign images via DALL-E 3 (primary) or Imagen 3 (fallback)
//   - Store generated images in R2
//   - Write asset metadata to D1 assets table
//   - Return R2 keys to the orchestrator for use by other agents
//   - No approval required for image generation itself — approval happens
//     at the campaign level (email, ads) when assets are used

import { OpenAIClient } from '../../lib/clients/openai';
import { GeminiClient } from '../../lib/clients/gemini';
import { Logger } from '../../lib/utils/logger';
import { generateId } from '../../lib/utils/id';
import { signMessage, buildSignaturePayload, verifySignature } from '../../lib/utils/signing';
import { ModelRouter } from '../../lib/utils/model-router';
import type { CreativeTask } from '../../lib/queues/schemas';

export interface CreativeAgentEnv {
  QUEUE_RESULTS: Queue;
  DB: D1Database;
  KV_CONFIG: KVNamespace;
  KV_CACHE: KVNamespace;
  R2_ASSETS: R2Bucket;
  // Secrets
  OPENAI_API_KEY: string;
  GEMINI_API_KEY: string;
  QUEUE_SIGNING_KEY: string;
  INTERNAL_API_KEY: string;
  MOCK_EXTERNAL_APIS: string;
}

const logger = new Logger('creative');

// Maps campaign format to DALL-E 3 size
const FORMAT_TO_SIZE: Record<string, '1024x1024' | '1024x1792' | '1792x1024'> = {
  '1:1': '1024x1024',
  '9:16': '1024x1792',
  '16:9': '1792x1024',
  '1.91:1': '1792x1024',
};

export default {
  async fetch(_request: Request, _env: CreativeAgentEnv): Promise<Response> {
    return new Response(JSON.stringify({ status: 'ok', service: 'agent-creative' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },

  async queue(batch: MessageBatch<CreativeTask>, env: CreativeAgentEnv): Promise<void> {
    const isMock = env.MOCK_EXTERNAL_APIS === 'true';
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

        const result = await generateImages(task, env, { openai, gemini, modelRouter });

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
          agent: 'creative',
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

// ─── Generate images ──────────────────────────────────────────────────────────

async function generateImages(
  task: CreativeTask,
  env: CreativeAgentEnv,
  clients: { openai: OpenAIClient; gemini: GeminiClient; modelRouter: ModelRouter }
): Promise<Record<string, unknown>> {
  const formats = task.formats ?? ['1:1'];
  const productContext = task.product_ids.join(', ');

  // 1. Generate detailed image prompt via Gemini Flash (cheap + fast)
  const briefModel = await clients.modelRouter.getModel('creative', 'image_brief');
  const briefResult = await clients.gemini.complete({
    model: briefModel.model as 'gemini-1.5-pro' | 'gemini-2.0-flash',
    messages: [
      {
        role: 'user',
        parts: [
          {
            text: `Create a detailed DALL-E 3 image generation prompt for an Angel Cosmetics ${task.campaign_type} campaign.

Products: ${productContext}
${task.style_context ? `Style context: ${task.style_context}` : ''}

Requirements:
- Premium cosmetics brand aesthetic
- Clean, minimalist styling
- Soft natural lighting
- Vegan/clean beauty visual language
- No text overlays
- Photo-realistic product photography style

Output a single detailed prompt string (no JSON, just the prompt text).`,
          },
        ],
      },
    ],
    system_instruction: 'You are a creative director specializing in premium cosmetics brand photography. Output concise, vivid image generation prompts.',
    temperature: 0.6,
  });

  const imagePrompt = briefResult.content.trim();

  // 2. Generate one image per requested format
  const assetKeys: string[] = [];
  const assetMetadata: Array<{
    id: string;
    r2_key: string;
    format: string;
    size: string;
    model: string;
    revised_prompt?: string;
  }> = [];

  const imageModel = await clients.modelRouter.getModel('creative', 'generate_image');
  const useImagen = imageModel.model !== 'dall-e-3';

  for (const format of formats) {
    const size = FORMAT_TO_SIZE[format] ?? '1024x1024';
    const assetId = generateId();
    const r2Key = `assets/${task.workflow_id}/${assetId}-${format.replace(':', 'x')}.png`;

    if (useImagen) {
      // Imagen 3 via Gemini client
      const aspectRatio = format as '1:1' | '9:16' | '16:9' | '4:3';
      const imagenResult = await clients.gemini.generateImage({
        prompt: imagePrompt,
        aspect_ratio: aspectRatio,
        number_of_images: 1,
      });

      if (imagenResult.images[0]) {
        const imageBytes = base64ToBytes(imagenResult.images[0].b64_json);
        await env.R2_ASSETS.put(r2Key, imageBytes, {
          httpMetadata: { contentType: 'image/png' },
          customMetadata: {
            workflow_id: task.workflow_id,
            campaign_type: task.campaign_type,
            format,
            model: 'imagen-3',
          },
        });

        assetKeys.push(r2Key);
        assetMetadata.push({ id: assetId, r2_key: r2Key, format, size, model: 'imagen-3' });
      }
    } else {
      // DALL-E 3 via OpenAI client
      const dalleResult = await clients.openai.generateImage({
        model: 'dall-e-3',
        prompt: imagePrompt,
        size,
        quality: format === '1:1' ? 'hd' : 'standard',
        n: 1,
      });

      const imageBytes = base64ToBytes(dalleResult.b64_json);
      await env.R2_ASSETS.put(r2Key, imageBytes, {
        httpMetadata: { contentType: 'image/png' },
        customMetadata: {
          workflow_id: task.workflow_id,
          campaign_type: task.campaign_type,
          format,
          model: 'dall-e-3',
          revised_prompt: dalleResult.revised_prompt,
        },
      });

      assetKeys.push(r2Key);
      assetMetadata.push({
        id: assetId,
        r2_key: r2Key,
        format,
        size,
        model: 'dall-e-3',
        revised_prompt: dalleResult.revised_prompt,
      });
    }

    // Write asset record to D1
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      'INSERT INTO assets (id, workflow_id, campaign_id, r2_key, asset_type, alt_text, dimensions, format, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      assetId,
      task.workflow_id,
      null,
      r2Key,
      'image',
      `Angel Cosmetics ${task.campaign_type} campaign image`,
      size,
      format,
      JSON.stringify({
        model: useImagen ? 'imagen-3' : 'dall-e-3',
        prompt: imagePrompt,
        campaign_type: task.campaign_type,
        product_ids: task.product_ids,
        created_at: now,
      })
    ).run();
  }

  logger.info('Images generated and stored in R2', {
    workflow_id: task.workflow_id,
    external_api: useImagen ? 'gemini-imagen3' : 'openai-dalle3',
    external_api_status: 200,
    input_tokens: briefResult.input_tokens,
    output_tokens: briefResult.output_tokens,
  });

  return {
    asset_keys: assetKeys,
    asset_count: assetKeys.length,
    assets: assetMetadata,
    image_prompt: imagePrompt,
  };
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
