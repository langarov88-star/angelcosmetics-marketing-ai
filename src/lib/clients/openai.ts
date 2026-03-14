// OpenAI API client — text completion + image generation

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: 'json_object' | 'text' };
}

export interface CompletionResult {
  content: string;
  input_tokens: number;
  output_tokens: number;
  model: string;
}

export interface ImageGenerationOptions {
  model: 'dall-e-3';
  prompt: string;
  size: '1024x1024' | '1024x1792' | '1792x1024';
  quality: 'standard' | 'hd';
  n: 1;
}

export interface ImageGenerationResult {
  b64_json: string;
  revised_prompt: string;
}

export class OpenAIClient {
  private readonly baseUrl = 'https://api.openai.com/v1';

  constructor(private readonly apiKey: string, private readonly mock = false) {}

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    if (this.mock) return this.mockCompletion(options);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.max_tokens ?? 2048,
        response_format: options.response_format,
      }),
    });

    if (!response.ok) {
      const status = response.status;
      throw new Error(`OpenAI API error: ${status}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
      model: string;
    };

    return {
      content: data.choices[0].message.content,
      input_tokens: data.usage.prompt_tokens,
      output_tokens: data.usage.completion_tokens,
      model: data.model,
    };
  }

  async generateImage(options: ImageGenerationOptions): Promise<ImageGenerationResult> {
    if (this.mock) return this.mockImageGeneration();

    const response = await fetch(`${this.baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model,
        prompt: options.prompt,
        size: options.size,
        quality: options.quality,
        n: 1,
        response_format: 'b64_json',
      }),
    });

    if (!response.ok) {
      const status = response.status;
      throw new Error(`OpenAI Images API error: ${status}`);
    }

    const data = await response.json() as {
      data: Array<{ b64_json: string; revised_prompt: string }>;
    };

    return data.data[0];
  }

  private mockCompletion(options: CompletionOptions): CompletionResult {
    return {
      content: `[MOCK] Response for model ${options.model}: ${options.messages[options.messages.length - 1].content.slice(0, 50)}...`,
      input_tokens: 100,
      output_tokens: 50,
      model: options.model,
    };
  }

  private mockImageGeneration(): ImageGenerationResult {
    return {
      b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      revised_prompt: '[MOCK] Angel Cosmetics product image',
    };
  }
}
