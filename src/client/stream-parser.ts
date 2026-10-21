/**
 * Robust SSE Stream Parser for streaming inference responses.
 */

export interface ChatChunkDelta {
  content?: string;
  role?: string;
  refusal?: string;
}

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: ChatChunkDelta;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export async function* parseEventStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        const lines = frame.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.slice(6);
            if (dataStr === '[DONE]') {
              return;
            }
            try {
              const chunk = JSON.parse(dataStr) as ChatCompletionChunk;
              yield chunk;
            } catch {
              // Ignore non-JSON lines or malformed framing
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
