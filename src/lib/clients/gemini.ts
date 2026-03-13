// Google Gemini API client — text generation + Imagen 3

export interface GeminiMessage {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

export interface GeminiCompletionOptions {
  model: 'gemini-1.5-pro' | 'gemini-2.0-flash';
  messages: GeminiMessage[];
  system_instruction?: string;
  temperature?: number;
  max_output_tokens?: number;
  enable_grounding?: boolean;  // web search grounding for content research
}

export interface GeminiCompletionResult {
  content: string;
  input_tokens: number;
  output_tokens: number;
  model: string;
}

export interface ImagenGenerationOptions {
  prompt: string;
  aspect_ratio: '1:1' | '9:16' | '16:9' | '4:3';
  number_of_images: 1 | 2 | 3 | 4;
}

export interface ImagenGenerationResult {
  images: Array<{ b64_json: string }>;
}

export class GeminiClient {
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  constructor(private readonly apiKey: string, private readonly mock = false) {}

  async complete(options: GeminiCompletionOptions): Promise<GeminiCompletionResult> {
    if (this.mock) return this.mockCompletion(options);

    const url = `${this.baseUrl}/models/${options.model}:generateContent?key=${this.apiKey}`;

    const body: Record<string, unknown> = {
      contents: options.messages,
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.max_output_tokens ?? 8192,
      },
    };

    if (options.system_instruction) {
      body['systemInstruction'] = { parts: [{ text: options.system_instruction }] };
    }

    if (options.enable_grounding) {
      body['tools'] = [{ googleSearch: {} }];
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const status = response.status;
      throw new Error(`Gemini API error: ${status}`);
    }

    const data = await response.json() as {
      candidates: Array<{
        content: { parts: Array<{ text: string }> };
      }>;
      usageMetadata: {
        promptTokenCount: number;
        candidatesTokenCount: number;
      };
    };

    return {
      content: data.candidates[0].content.parts[0].text,
      input_tokens: data.usageMetadata.promptTokenCount,
      output_tokens: data.usageMetadata.candidatesTokenCount,
      model: options.model,
    };
  }

  async generateImage(options: ImagenGenerationOptions): Promise<ImagenGenerationResult> {
    if (this.mock) return this.mockImageGeneration();

    const url = `${this.baseUrl}/models/imagen-3.0-generate-001:predict?key=${this.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt: options.prompt }],
        parameters: {
          sampleCount: options.number_of_images,
          aspectRatio: options.aspect_ratio,
        },
      }),
    });

    if (!response.ok) {
      const status = response.status;
      throw new Error(`Imagen 3 API error: ${status}`);
    }

    const data = await response.json() as {
      predictions: Array<{ bytesBase64Encoded: string }>;
    };

    return {
      images: data.predictions.map(p => ({ b64_json: p.bytesBase64Encoded })),
    };
  }

  private mockCompletion(options: GeminiCompletionOptions): GeminiCompletionResult {
    return {
      content: `[MOCK Gemini] Response for ${options.model}`,
      input_tokens: 150,
      output_tokens: 75,
      model: options.model,
    };
  }

  private mockImageGeneration(): ImagenGenerationResult {
    return {
      images: [{
        b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      }],
    };
  }
}
