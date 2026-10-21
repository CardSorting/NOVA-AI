import type { IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import { functionInput, functionToolContract } from './function-tools.js';

export class RequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public executionState?: 'not_accepted' | 'unknown' | 'failed',
    public shouldRetry = false,
  ) { super(message); }
}
export function readJsonBody(req: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0; let settled = false;
    const cleanup = () => { clearTimeout(timer); req.off('data', onData); req.off('end', onEnd); req.off('aborted', onAbort); req.off('error', onAbort); };
    const fail = (error: RequestError) => { if (settled) return; settled = true; cleanup(); req.resume(); reject(error); };
    const onAbort = () => fail(new RequestError(400, 'request_aborted', 'Request body was interrupted. Send the complete request again.'));
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) return fail(new RequestError(413, 'payload_too_large', `Request body exceeds ${maxBytes} bytes.`));
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = () => {
      if (settled) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        settled = true; cleanup(); resolve(body);
      } catch { fail(new RequestError(400, 'invalid_json', 'Send a JSON object as the request body.')); }
    };
    const timer = setTimeout(() => fail(new RequestError(408, 'request_timeout', 'Request body timed out. Send the complete request again.')), timeoutMs);
    req.on('data', onData); req.once('end', onEnd); req.once('aborted', onAbort); req.once('error', onAbort);
  });
}
export function validateModelRequest(body: Record<string, any>, image = false) {
  const invalid = (message: string): never => { throw new RequestError(400, 'invalid_request', message); };
  if (body.model !== undefined && (typeof body.model !== 'string' || !/^[\w.:-]{1,96}$/.test(body.model))) invalid('model must be a model identifier of 1–96 characters.');
  if (typeof body.model === 'string' && body.model.startsWith('image:')) invalid('Use the model identifier without the internal image: capability prefix.');
  if (image) {
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) invalid('prompt must be a nonempty string.');
    if (body.idempotency_key !== undefined && (typeof body.idempotency_key !== 'string' || body.idempotency_key.length > 128)) invalid('idempotency_key must be a string of at most 128 characters.');
    return;
  }
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 1000) invalid('messages must contain between 1 and 1000 messages.');
  for (const message of body.messages) {
    if (!message || !['system','developer','user','assistant','tool'].includes(message.role)) invalid('Each message must have a supported role.');
    if (typeof message.content !== 'string' && !Array.isArray(message.content) && !(message.role === 'assistant' && message.content === null && message.tool_calls?.length)) invalid('Each message must contain text or an array of content parts.');
  }
  try { functionToolContract(body); functionInput(body.messages); }
  catch { invalid('Provide valid function definitions and matching tool call results.'); }
  if (body.durable_receipt === true && (body.tools?.length || body.messages.some((m: any) => m.role === 'tool' || m.tool_calls !== undefined))) invalid('Function calls require the chat completion contract.');
  const effort = body.reasoning_effort ?? body.reasoningEffort;
  if (effort !== undefined && !['none','minimal','low','medium','high','xhigh','max'].includes(effort)) invalid('reasoning_effort is not supported.');
  if (body.max_tokens !== undefined && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1)) invalid('max_tokens must be a positive integer.');
}
/** Only retries spend credits. New requests have no quota imposed by this budget. */
export class RetryBudget {
  private credits = 20; private updatedAt: number;
  constructor(private clock = () => performance.now()) { this.updatedAt = clock(); }
  private refill() { const now = this.clock(); this.credits = Math.min(20, this.credits + Math.max(0, now - this.updatedAt) / 10000); this.updatedAt = now; }
  take() { this.refill(); if (this.credits < 1) return false; this.credits--; return true; }
  success() { this.refill(); this.credits = Math.min(20, this.credits + 1); }
  snapshot() { this.refill(); return { available: Math.floor(this.credits), capacity: 20 }; }
}
