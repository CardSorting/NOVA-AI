import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { QueuedHttpResponse } from './pool-request-queue.js';

const RESPONSE_HEADERS = new Set([
  'content-type',
  'cache-control',
  'x-content-type-options',
  'referrer-policy',
  'retry-after',
  'x-should-retry',
]);
const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export class QueueIncomingMessage extends EventEmitter {
  readonly method = 'POST';
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  aborted = false;
  destroyed = false;

  constructor(pathname: string, headers: IncomingHttpHeaders, body: Record<string, unknown>) {
    super();
    this.url = pathname;
    this.headers = headers;
    queueMicrotask(() => {
      this.emit('data', Buffer.from(JSON.stringify(body)));
      this.emit('end');
    });
  }

  resume(): this {
    return this;
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.emit('aborted');
  }
}

export class QueueServerResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  destroyed = false;
  writableEnded = false;
  private readonly headers = new Map<string, string>();
  private readonly chunks: Buffer[] = [];

  setHeader(name: string, value: number | string | readonly string[]): this {
    this.headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
    return this;
  }

  hasHeader(name: string): boolean {
    return this.headers.has(name.toLowerCase());
  }

  writeHead(statusCode: number, headers: Record<string, number | string | readonly string[]> = {}): this {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    this.headersSent = true;
    return this;
  }

  write(chunk: string | Uint8Array): boolean {
    if (this.destroyed || this.writableEnded) return false;
    this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    return true;
  }

  end(chunk?: string | Uint8Array): this {
    if (chunk !== undefined) this.write(chunk);
    this.writableEnded = true;
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  captured(): { status: number; headers: Map<string, string>; body: Buffer } {
    return { status: this.statusCode, headers: new Map(this.headers), body: Buffer.concat(this.chunks) };
  }
}

export function serializeQueueResponse(response: QueueServerResponse): QueuedHttpResponse {
  const captured = response.captured();
  if (!Number.isInteger(captured.status) || captured.status < 200 || captured.status > 599 || captured.body.byteLength > 64 * 1024 * 1024) {
    throw new Error('Invalid internal relay response.');
  }
  const headers: Record<string, string> = {};
  for (const name of RESPONSE_HEADERS) {
    const value = captured.headers.get(name);
    if (value === undefined || value.length > 256 || /[\r\n]/.test(value)) continue;
    if (name === 'content-type') {
      if (value === 'application/json' || IMAGE_CONTENT_TYPES.has(value)) headers[name] = value;
    } else if (name === 'retry-after') {
      if (/^\d{1,4}$/.test(value)) headers[name] = value;
    } else if (name === 'x-should-retry') {
      if (value === 'true' || value === 'false') headers[name] = value;
    } else if (name === 'cache-control') {
      if (value === 'no-store') headers[name] = value;
    } else if (name === 'x-content-type-options') {
      if (value === 'nosniff') headers[name] = value;
    } else if (name === 'referrer-policy') {
      if (value === 'no-referrer') headers[name] = value;
    }
  }
  const contentType = headers['content-type'] ?? 'application/json';
  if (IMAGE_CONTENT_TYPES.has(contentType)) return { status: captured.status, headers, body: captured.body.toString('base64'), encoding: 'base64' };
  return { status: captured.status, headers, body: captured.body.toString('utf8'), encoding: 'utf8' };
}

export function writeQueueResponse(response: ServerResponse, queued: QueuedHttpResponse): void {
  for (const [name, value] of Object.entries(queued.headers)) {
    if (RESPONSE_HEADERS.has(name) && !/[\r\n]/.test(value) && value.length <= 256) response.setHeader(name, value);
  }
  const body = queued.encoding === 'base64' ? Buffer.from(queued.body, 'base64') : queued.body;
  response.writeHead(queued.status, queued.headers);
  response.end(body);
}

export function asIncomingMessage(request: QueueIncomingMessage): IncomingMessage {
  return request as unknown as IncomingMessage;
}

export function asServerResponse(response: QueueServerResponse): ServerResponse {
  return response as unknown as ServerResponse;
}
