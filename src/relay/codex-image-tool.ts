import { randomUUID } from 'node:crypto';
import { decodeImageBase64, sanitizeImageArtifact } from '../security/image-artifact.js';

// Matches Codex's image-generation extension / ImagesClient, not Responses tools.
// Private protocol identifiers do not establish a public underlying-model guarantee.
export const CODEX_IMAGE_TOOL_ENDPOINT = 'https://chatgpt.com/backend-api/codex/images/generations';
export const CODEX_IMAGE_TOOL_MODEL = 'gpt-image-2';

export class CodexImageToolError extends Error {
  constructor(readonly code: string, readonly upstream?: { status: number; headers: { 'retry-after': string | null } }) {
    super(code); // Never retain provider text, credentials, headers or image metadata.
  }
}

async function readResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await response.body?.cancel();
    throw new CodexImageToolError('codex_image_response_limit');
  }
  if (!response.body) throw new CodexImageToolError('codex_image_missing_body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks, bytes);
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new CodexImageToolError('codex_image_response_limit');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** One dispatch to the backend used by image_gen.imagegen. No retry or fallback. */
export async function generateCodexToolImage(
  prompt: string,
  account: { accessToken: string; accountId: string },
  signal: AbortSignal,
  maxBytes = 32 * 1024 * 1024,
  transport: typeof fetch = fetch,
): Promise<{ b64_json: string; revised_prompt?: string }> {
  signal.throwIfAborted();
  if (!prompt.trim() || !account.accessToken || !account.accountId || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new CodexImageToolError('codex_image_invalid_request');
  }
  const response = await transport(CODEX_IMAGE_TOOL_ENDPOINT, {
    method: 'POST', redirect: 'error', signal,
    headers: {
      Authorization: `Bearer ${account.accessToken}`,
      'ChatGPT-Account-Id': account.accountId,
      'Content-Type': 'application/json',
      originator: 'codex_cli',
      'User-Agent': 'codex_cli_rs/0.154.0',
      'x-codex-image-turn-id': randomUUID(),
    },
    body: JSON.stringify({ model: CODEX_IMAGE_TOOL_MODEL, prompt, background: 'auto', quality: 'auto', size: 'auto' }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new CodexImageToolError('codex_image_request_failed', {
      status: response.status, headers: { 'retry-after': response.headers.get('retry-after') },
    });
  }
  const bytes = await readResponse(response, maxBytes);
  signal.throwIfAborted();
  let data: unknown;
  try { data = JSON.parse(bytes.toString('utf8')); }
  catch { throw new CodexImageToolError('codex_image_invalid_response'); }
  const items = data && typeof data === 'object' && 'data' in data ? data.data : undefined;
  if (!Array.isArray(items) || items.length !== 1 || !items[0] || typeof items[0] !== 'object') {
    throw new CodexImageToolError('codex_image_invalid_response');
  }
  try {
    const image = await sanitizeImageArtifact(decodeImageBase64(items[0].b64_json));
    signal.throwIfAborted();
    return { b64_json: image.bytes.toString('base64') };
  } catch {
    signal.throwIfAborted();
    throw new CodexImageToolError('codex_image_invalid_artifact');
  }
}
