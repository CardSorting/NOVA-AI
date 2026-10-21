import { parseEventStream, type ChatCompletionChunk } from './stream-parser.js';
import { sanitizeImageArtifact, decodeImageBase64, type PublicImageArtifact } from '../security/image-artifact.js';

export interface RelayClientOptions {
  baseUrl: string;
  apiKey: string;
  tenant?: string;
  timeoutMs?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  name?: string;
}

export interface ChatCompletionRequestOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  idempotencyKey?: string;
  stream?: boolean;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<Record<string, unknown>>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ImageGenerationRequestOptions {
  prompt: string;
  model?: string;
  n?: number;
  size?: string;
  response_format?: 'b64_json' | 'url';
  idempotencyKey?: string;
}

export interface ImageGenerationResponse {
  created: number;
  data: Array<{
    b64_json?: string;
    url?: string;
  }>;
  artifact?: PublicImageArtifact;
}

export class NovaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly tenant?: string;
  private readonly timeoutMs: number;

  constructor(options: RelayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.tenant = options.tenant;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  private headers(idempotencyKey?: string): Record<string, string> {
    const h: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (this.tenant) {
      h['x-nova-tenant'] = this.tenant;
      h['x-galx-tenant'] = this.tenant;
    }
    if (idempotencyKey) {
      h['Idempotency-Key'] = idempotencyKey;
    }
    return h;
  }

  public async chat(options: ChatCompletionRequestOptions): Promise<ChatCompletionResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(options.idempotencyKey),
      body: JSON.stringify({ ...options, stream: false }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    if (!response.ok && response.status !== 202) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`Relay request failed [${response.status}]: ${errBody}`);
    }

    if (response.status === 202) {
      const job = (await response.json()) as { id: string; model?: string; streamUrl?: string };
      let accumulated = '';
      let finishReason = 'stop';
      let role = 'assistant';
      for await (const chunk of this.chatStream(options)) {
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) accumulated += delta.content;
        if (delta?.role) role = delta.role;
        if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
      }
      return {
        id: job.id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: job.model || options.model,
        choices: [{
          index: 0,
          message: { role, content: accumulated },
          finish_reason: finishReason
        }]
      };
    }

    return (await response.json()) as ChatCompletionResponse;
  }

  public async *chatStream(
    options: ChatCompletionRequestOptions
  ): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(options.idempotencyKey),
      body: JSON.stringify({ ...options, stream: true }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    if (!response.ok && response.status !== 202) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`Relay stream failed [${response.status}]: ${errBody}`);
    }

    if (response.status === 202) {
      const job = (await response.json()) as { streamUrl?: string; id?: string };
      const streamUrl = job.streamUrl ?? (job.id ? `/v1/jobs/${job.id}/stream` : undefined);
      if (!streamUrl) {
        throw new Error('Relay 202 response missing streamUrl or id');
      }
      const streamResponse = await fetch(`${this.baseUrl}${streamUrl}`, {
        headers: {
          ...this.headers(),
          'Accept': 'text/event-stream'
        },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!streamResponse.ok) {
        const errBody = await streamResponse.text().catch(() => '');
        throw new Error(`Relay stream failed [${streamResponse.status}]: ${errBody}`);
      }
      if (!streamResponse.body) {
        throw new Error('Response body is empty, expected event-stream');
      }
      yield* parseEventStream(streamResponse.body);
      return;
    }

    if (!response.body) {
      throw new Error('Response body is empty, expected event-stream');
    }

    yield* parseEventStream(response.body);
  }

  public async generateImage(options: ImageGenerationRequestOptions): Promise<ImageGenerationResponse> {
    const url = `${this.baseUrl}/v1/images/generations`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(options.idempotencyKey),
      body: JSON.stringify({
        ...options,
        model: options.model || 'gpt-image-1',
        response_format: 'b64_json'
      }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`Relay image failed [${response.status}]: ${errBody}`);
    }

    const result = (await response.json()) as ImageGenerationResponse;
    const b64 = result.data?.[0]?.b64_json;
    if (b64) {
      const decoded = decodeImageBase64(b64);
      result.artifact = await sanitizeImageArtifact(decoded);
    }
    return result;
  }

  public async getJob(jobId: string): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/v1/jobs/${encodeURIComponent(jobId)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      throw new Error(`Get job failed [${response.status}]`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  public async listModels(): Promise<Array<{ id: string; object: string }>> {
    const url = `${this.baseUrl}/v1/models`;
    const response = await fetch(url, {
      method: 'GET',
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      throw new Error(`List models failed [${response.status}]`);
    }
    const data = (await response.json()) as { data: Array<{ id: string; object: string }> };
    return data.data || [];
  }
}

export const RelayClient = NovaClient;
export type RelayClient = NovaClient;
