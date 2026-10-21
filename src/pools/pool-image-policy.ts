import type { IncomingMessage, ServerResponse } from 'node:http';

export type RelayImagePool = 'premium';
export function imagePool(value: unknown): RelayImagePool {
  if (value !== 'premium') throw new Error('Invalid relay image identity');
  return value;
}

/** Packaging readiness only. Activation requires a different, reviewed runtime. */
export function stagedPoolRequest(req: IncomingMessage, res: ServerResponse, pool: RelayImagePool,
  administrator: () => boolean): void {
  const reply = (status: number, body: object) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', Connection: 'close' });
    res.end(JSON.stringify(body));
  };
  let pathname: string;
  try { pathname = new URL(req.url ?? '/', 'http://localhost').pathname; }
  catch { return reply(400, { error: { code: 'invalid_request', message: 'Invalid request.' } }); }
  if (req.method === 'GET' && ['/health', '/health/live'].includes(pathname)) {
    return reply(200, { status: 'ok' });
  }
  if (pathname === '/health/ready' || pathname.startsWith('/api/') || pathname === '/metrics') {
    if (!administrator()) return reply(401, { error: { code: 'unauthorized', message: 'Authorization required.' } });
    if (pathname === '/health/ready' && req.method === 'GET') {
      return reply(503, { ready: false, stage: 'awaiting-central-authorization', pool,
        accountClass: 'paid',
        allowedWorkloads: ['text', 'sites', 'images'] });
    }
  }
  // Includes aliases, probes, recovery, unknown routes and generic tool requests.
  // No body is read and no engine handler can select credentials or call a provider.
  reply(503, { error: { code: 'service_unavailable', message: 'This service is temporarily unavailable.' } });
}
