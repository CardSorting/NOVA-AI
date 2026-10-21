import { classifyCapabilityFailure } from './capability-registry.js';
/** Provider feedback is evidence; a local observation window is not a quota. */
export interface ProviderLimit {
  name: string;
  limit: number | null;
  remaining: number;
  resetAtMs: number | null;
}

export function retryDeadline(value: unknown, now = Date.now()): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now + Math.max(1000, seconds * 1000);
  const date = Date.parse(String(value));
  if (Number.isFinite(date)) return Math.max(now + 1000, date);
}

export function classifyUpstreamError(frame: any, now = Date.now()) {
  const error = frame?.error ?? frame?.response?.error ?? frame ?? {};
  const code = String(error.code ?? frame?.status ?? frame?.status_code ?? 'unknown');
  const description = `${code} ${frame?.status ?? frame?.status_code ?? ''} ${error.type ?? ''} ${error.message ?? ''}`.toLowerCase();
  const status = Number(frame?.status ?? frame?.status_code ?? (/^\d{3}$/.test(code) ? code : NaN));
  const requestRejected = !!classifyCapabilityFailure(frame) || /\b(invalid_request(?:_error)?|invalid_argument|context_length(?:_exceeded)?|model_not_found|unsupported_parameter|model_permission_denied)\b/.test(description);
  const unauthorized = !requestRejected && (status === 401 || /\b(invalid_api_key|token_expired|invalid_token|token_revoked|account_deactivated|session_expired|session_revoked|authentication_error)\b/.test(description));
  const quota = !requestRejected && (status === 429 || /\b(rate[ _-]?limit(?:ed|_exceeded)?|insufficient_quota|usage_limit(?:_reached)?|too many requests)\b/.test(description));
  const reset = Number(error.resets_at ?? error.reset_at ?? frame?.resets_at);
  const deadline = Number.isFinite(reset) && reset > 0
    ? Math.max(now + 1000, reset < 1e12 ? reset * 1000 : reset)
    : retryDeadline(error.retry_after_seconds ?? error.retry_after ?? frame?.retry_after ?? frame?.headers?.['retry-after'], now);
  const permanent = requestRejected || (status >= 400 && status < 500 && ![401, 408, 429].includes(status));
  return { code, quota: quota && !unauthorized, unauthorized, deadline, retryable: quota || unauthorized || !permanent };
}

export function cooldownDeadline(failures: number, now: number, providerDeadline?: number): number {
  // Trust an explicit provider reset; estimate only when it is unknown.
  if (providerDeadline && Number.isFinite(providerDeadline)) return Math.max(now + 1000, providerDeadline);
  const fallback = Math.min(30 * 60_000, 60_000 * 2 ** Math.min(10, Math.max(0, failures - 1)));
  return now + fallback;
}

export function parseProviderLimits(values: any[], now = Date.now()): ProviderLimit[] {
  return values.filter(v => typeof v?.remaining === 'number' && Number.isFinite(v.remaining)).map(v => ({
    name: String(v.name ?? 'requests'),
    limit: typeof v.limit === 'number' && Number.isFinite(v.limit) ? v.limit : null,
    remaining: Math.max(0, v.remaining),
    resetAtMs: retryDeadline(v.reset_seconds, now) ?? null,
  }));
}
