import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RequestError, RetryBudget } from '../relay/request-policy.js';

export type PoolId = 'premium';
export type Workload = 'text' | 'sites' | 'images';
export const PROJECTS = { central: 'mazhcjisettrzbqhorvp', premium: 'prgjcyokylzcsqrjmkaa' } as const;
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export const equalSecret = (a: unknown, b: string) => typeof a === 'string' && timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
export function bearer(req: IncomingMessage) {
  const value = req.headers.authorization;
  if (typeof value !== 'string' || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(value)) throw new RequestError(401, 'unauthorized', 'Sign in to continue.');
  return value.slice(7);
}
export function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(value));
}
export function failure(res: ServerResponse, error: unknown) {
  const status = error instanceof RequestError ? error.status : 503;
  if ((status === 429 || status === 503) && !res.hasHeader('Retry-After')) res.setHeader('Retry-After', '2');
  if (error instanceof RequestError && error.shouldRetry) res.setHeader('x-should-retry', 'true');
  json(res, status, { error: {
    code: error instanceof RequestError ? error.code : 'service_unavailable',
    message: error instanceof RequestError ? error.message : 'This service is temporarily unavailable.',
    ...(error instanceof RequestError && error.executionState ? { execution_state: error.executionState } : {}),
  } });
}
export function exactKeys(body: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(body).some(key => !keys.includes(key))) throw new RequestError(400, 'invalid_request', 'The request contains unsupported fields.');
}
/** Fixed recovery messages for authenticated registration controls; never forward upstream text. */
export const registrationErrors: Record<string, { status: number; message: string }> = {
  credential_account_ambiguous: { status: 409, message: 'Multiple saved account records match this sign-in. An administrator must reconcile them before registration.' },
  credential_not_allowed: { status: 409, message: 'This account cannot be registered here. Ask an administrator to review its existing access and registration.' },
  credential_account_mismatch: { status: 409, message: 'This sign-in does not match the saved account. Sign in to the intended account, then connect again.' },
  credential_missing: { status: 422, message: 'No saved sign-in was found. Complete sign-in in this desktop, then connect again.' },
  credential_invalid: { status: 422, message: 'We could not read the saved sign-in. Start sign-in again, then connect this account.' },
  credential_expired: { status: 422, message: 'Your sign-in has expired. Start sign-in again, then reconnect this account.' },
  credential_older: { status: 409, message: 'A newer sign-in is already saved. Refresh this connection to use it.' },
  credential_rejected: { status: 422, message: 'This sign-in was not accepted. Start sign-in again, then reconnect this account.' },
  credential_check_unavailable: { status: 503, message: 'Account access could not be checked. Keep the saved sign-in and try connecting later.' },
  credential_registry_unavailable: { status: 503, message: 'The connection is not confirmed yet. Your saved sign-in is safe. Refresh its status before trying again.' },
  credential_conflict: { status: 409, message: 'The saved sign-in changed during review. Refresh, then connect again.' },
};
export function serviceOrigin(value: string) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname)))) throw Error('An exact HTTPS service origin is required.');
  return u.origin;
}
export function assertProjectDatabase(value: string, project: string, deployment?: unknown) {
  const u = new URL(value);
  if(deployment!==undefined){
    const central=project===PROJECTS.central,premium=project===PROJECTS.premium;
    if(deployment!=='native-postgres-v1'||(!central&&!premium)||!['postgres:','postgresql:'].includes(u.protocol)||u.search||u.hash
      ||u.hostname!==(central?'host.docker.internal':'galx-postgres-premium.internal')
      ||u.port!==(central?'55432':'55433')||u.pathname!==(central?'/galxai':'/galx_relay_premium')
      ||decodeURIComponent(u.username)!==(central?'galx_control_service':'galx_execution_service')||!u.password)throw Error('Database project mismatch.');
    return;
  }
  if (!['postgres:', 'postgresql:'].includes(u.protocol) || !(u.hostname === `db.${project}.supabase.co` || u.hostname.endsWith('.pooler.supabase.com') && decodeURIComponent(u.username).endsWith(`.${project}`))) throw Error('Database project mismatch.');
}
/** Client-owned functions are text inference. Provider-hosted tools cannot bypass pool scope. */
export function requestWorkload(pool: PoolId, pathname: string, body: Record<string, any>): Workload {
  const image = pathname.includes('/images/') || /^(image:|gpt-image|dall-e)/i.test(body.model ?? '');
  const sites = body.sites_profile !== undefined || body.require_output_limit !== undefined;
  return image ? 'images' : sites ? 'sites' : 'text';
}
export interface PoolIdentity { pool: PoolId; installationId: string; }
export class CentralClient {
  readonly origin: string;
  private readonly readRetryBudget = new RetryBudget();
  private readonly readCircuit = { failures: 0, openUntil: 0, probeInFlight: false };
  constructor(origin: string, private readonly token: string, readonly identity: PoolIdentity, private readonly transport: typeof fetch = fetch) {
    this.origin = serviceOrigin(origin);
    if (identity.pool !== 'premium' || !uuid(identity.installationId) || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw Error('Invalid service identity.');
  }
  private beginSafeRead() {
    const now = Date.now();
    if (this.readCircuit.openUntil > now) throw new RequestError(503, 'control_unavailable', 'The control service is recovering. Refresh in a moment.');
    if (this.readCircuit.failures >= 3) {
      if (this.readCircuit.probeInFlight) throw new RequestError(503, 'control_unavailable', 'The control service is recovering. Refresh in a moment.');
      this.readCircuit.probeInFlight = true;
    }
  }
  private safeReadHealthy() {
    this.readCircuit.failures = 0;
    this.readCircuit.openUntil = 0;
    this.readCircuit.probeInFlight = false;
    this.readRetryBudget.success();
  }
  private safeReadFailed() {
    this.readCircuit.failures = Math.min(3, this.readCircuit.failures + 1);
    this.readCircuit.probeInFlight = false;
    if (this.readCircuit.failures >= 3) this.readCircuit.openUntil = Date.now() + 4000;
  }
  async call<T = any>(route: string, body: Record<string, unknown> = {}): Promise<T> {
    if (!/^\/(runtime|operator|registrar)\/[a-z_-]+$/.test(route)) throw Error('Invalid service route.');
    // Status and operation reads are safe to retry. Mutating registrar and account
    // calls deliberately stay single-shot; their durable operation identities make
    // an explicit user retry safe without replaying a credential write here.
    const retryableRead = route === '/operator/status' || route === '/operator/operation';
    const retryableStatus = (status: number) => [429, 502, 503, 504].includes(status);
    const timeoutMs = retryableRead ? 5000 : 12000;
    if (retryableRead) this.beginSafeRead();
    let attempt = 0;
    for (;;) {
      try {
        const response = await this.transport(this.origin + route, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...this.identity }) });
        // Bound credential-bearing replies; never include raw responses in errors or logs.
        const reader = response.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
        try { if (reader) for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > 8 * 1024 * 1024) throw Error('Service response exceeded the safety limit.'); chunks.push(r.value); } }
        finally { await reader?.cancel().catch(() => {}); }
        if (retryableRead && !retryableStatus(response.status)) this.safeReadHealthy();
        if (!response.ok) {
          let code:string|undefined;try{code=JSON.parse(Buffer.concat(chunks).toString('utf8'))?.error?.code;}catch{}
          if(code && Object.hasOwn(registrationErrors,code)) {
            const known=registrationErrors[code];throw new RequestError(known.status,code,known.message);
          }
          const reviewErrors:Record<string,string>={
            account_type_mismatch:'Sign in with a paid account for this registration.',
            account_type_unverified:'The account type could not be verified. Sign in again, then review the account.',
            models_unverified:'Model access could not be verified. Review the account after its connection is restored.',
            account_check_unavailable:'Account review is unavailable. Restore the central account service before retrying.',
          };
          if(code==='record_changed')throw new RequestError(409,code,'This item changed while you were editing. Close this dialog, refresh, and try again.');
          if(code&&Object.hasOwn(reviewErrors,code))throw new RequestError(response.status===422?422:503,code,reviewErrors[code]);
          throw new RequestError([400,401,403,404,409,429].includes(response.status) ? response.status : 503, 'control_unavailable', 'We could not confirm that change. Your saved sign-in is safe. Refresh its status before retrying.');
        }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('Invalid service response.'); }
      } catch (error) {
        const status = error instanceof RequestError ? error.status : undefined;
        const canRetry = retryableRead && attempt < 2 && (status === undefined || retryableStatus(status));
        if (!canRetry) {
          if (retryableRead && (status === undefined || retryableStatus(status))) this.safeReadFailed();
          throw error;
        }
        if (!this.readRetryBudget.take()) {
          this.safeReadFailed();
          throw error;
        }
        // Small bounded exponential backoff with jitter prevents a monitor fleet
        // from stampeding a recovering control service while keeping reads snappy.
        const delay = Math.round((150 * 2 ** attempt) * (0.8 + Math.random() * 0.4));
        attempt++;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}
