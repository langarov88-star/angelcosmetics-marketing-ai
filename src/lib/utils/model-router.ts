// Model routing: selects the right AI model per agent + task
// Config is read from KV_CONFIG at runtime; falls back to hardcoded defaults

export type ModelProvider = 'openai' | 'gemini';
export type OpenAIModel = 'gpt-4o' | 'gpt-4o-mini' | 'o3';
export type GeminiModel = 'gemini-1.5-pro' | 'gemini-2.0-flash';
export type ImageModel = 'dall-e-3' | 'imagen-3';
export type AnyModel = OpenAIModel | GeminiModel | ImageModel;

export interface ModelConfig {
  provider: ModelProvider;
  model: AnyModel;
}

// Default routing table — overridable via KV key: agent:<name>:model:<task>
const DEFAULT_ROUTING: Record<string, ModelConfig> = {
  'email:draft_copy':            { provider: 'openai',  model: 'gpt-4o' },
  'email:subject_lines':         { provider: 'openai',  model: 'gpt-4o-mini' },
  'google-ads:ad_copy':          { provider: 'openai',  model: 'gpt-4o' },
  'google-ads:keyword_research': { provider: 'gemini',  model: 'gemini-1.5-pro' },
  'meta:ad_copy':                { provider: 'openai',  model: 'gpt-4o' },
  'content:research':            { provider: 'gemini',  model: 'gemini-1.5-pro' },
  'content:draft_post':          { provider: 'openai',  model: 'gpt-4o' },
  'content:product_descriptions':{ provider: 'openai',  model: 'gpt-4o-mini' },
  'creative:image_brief':        { provider: 'openai',  model: 'gpt-4o-mini' },
  'creative:generate_image':     { provider: 'openai',  model: 'dall-e-3' },
  'analytics:report_synthesis':  { provider: 'gemini',  model: 'gemini-1.5-pro' },
  'analytics:insight_bullets':   { provider: 'openai',  model: 'gpt-4o-mini' },
  'orchestrator:task_routing':   { provider: 'openai',  model: 'gpt-4o-mini' },
};

// Fallback models when primary is unavailable
const FALLBACKS: Record<string, ModelConfig> = {
  'openai:gpt-4o':        { provider: 'gemini', model: 'gemini-1.5-pro' },
  'openai:gpt-4o-mini':   { provider: 'gemini', model: 'gemini-2.0-flash' },
  'openai:dall-e-3':      { provider: 'gemini', model: 'imagen-3' },
  'gemini:gemini-1.5-pro':{ provider: 'openai', model: 'gpt-4o' },
  'gemini:gemini-2.0-flash':{ provider: 'openai', model: 'gpt-4o-mini' },
};

export class ModelRouter {
  constructor(private readonly kvConfig: KVNamespace) {}

  async getModel(agent: string, task: string): Promise<ModelConfig> {
    const kvKey = `agent:${agent}:model:${task}`;

    try {
      const override = await this.kvConfig.get(kvKey);
      if (override) {
        const parsed = JSON.parse(override) as ModelConfig;
        return parsed;
      }
    } catch {
      // KV unavailable — use default
    }

    const defaultKey = `${agent}:${task}`;
    return DEFAULT_ROUTING[defaultKey] ?? { provider: 'openai', model: 'gpt-4o-mini' };
  }

  getFallback(config: ModelConfig): ModelConfig {
    const key = `${config.provider}:${config.model}`;
    return FALLBACKS[key] ?? { provider: 'openai', model: 'gpt-4o-mini' };
  }
}
