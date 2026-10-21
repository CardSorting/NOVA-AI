/**
 * A deliberately tiny, private failure contract between an assigned relay
 * worker and its owning pool runtime.
 *
 * The pool is allowed to use this signal for routing and cooldown decisions;
 * the application is never allowed to forward it to callers. Keep this a
 * fixed vocabulary. Provider messages, headers, credentials, prompts and
 * topology never cross this boundary.
 */

export const PRIVATE_RELAY_FAILURE_HEADER = 'x-galx-relay-failure';
export const PRIVATE_RELAY_FAILURE_VERSION = 'v1';
export const MAX_PRIVATE_RETRY_AFTER_MS = 30 * 60_000;

export const RELAY_FAILURE_CLASSES = [
  'capability_denied',
  'capability_temporarily_unavailable',
  'pre_generation_rejected',
  'rate_limited',
  'upstream_unavailable',
  'upstream_timeout',
  'invalid_upstream_response',
  'request_rejected',
  'worker_unavailable',
  'fleet_unavailable',
  'unknown',
] as const;

export type RelayFailureClass = (typeof RELAY_FAILURE_CLASSES)[number];
export type RelayFailureScope = 'worker' | 'fleet' | 'request';

export interface PrivateRelayFailure {
  version: typeof PRIVATE_RELAY_FAILURE_VERSION;
  class: RelayFailureClass;
  scope: RelayFailureScope;
  retryAfterMs?: number;
}

const failureClasses = new Set<string>(RELAY_FAILURE_CLASSES);
const scopes = new Set<RelayFailureScope>(['worker', 'fleet', 'request']);

function boundedRetryAfter(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value <= 0) return 1000;
  return Math.min(MAX_PRIVATE_RETRY_AFTER_MS, Math.max(1000, Math.round(value)));
}

export function privateRelayFailure(
  failure: Omit<PrivateRelayFailure, 'version'>,
): PrivateRelayFailure {
  const retry = boundedRetryAfter(failure.retryAfterMs);
  return {
    version: PRIVATE_RELAY_FAILURE_VERSION,
    class: failure.class,
    scope: failure.scope,
    ...(retry === undefined
      ? {}
      : { retryAfterMs: retry }),
  };
}

/** Header-safe encoding: fixed fields only, no JSON or provider-controlled text. */
export function encodePrivateRelayFailure(failure: PrivateRelayFailure): string {
  const safe = privateRelayFailure(failure);
  return [safe.version, safe.class, safe.scope, safe.retryAfterMs ?? ''].join(':');
}

export function decodePrivateRelayFailure(value: string | null | undefined): PrivateRelayFailure | undefined {
  if (!value || value.length > 128) return undefined;
  const [version, failureClass, scope, retryAfter] = value.split(':');
  if (version !== PRIVATE_RELAY_FAILURE_VERSION || !failureClasses.has(failureClass) || !scopes.has(scope as RelayFailureScope)) return undefined;
  const parsedRetry = retryAfter === '' ? undefined : Number(retryAfter);
  if (retryAfter !== '' && (parsedRetry === undefined || !Number.isFinite(parsedRetry) || parsedRetry < 0)) return undefined;
  return privateRelayFailure({
    class: failureClass as RelayFailureClass,
    scope: scope as RelayFailureScope,
    retryAfterMs: parsedRetry,
  });
}

export function retryAfterSeconds(failure: PrivateRelayFailure | undefined): number | undefined {
  if (!failure?.retryAfterMs) return undefined;
  return Math.max(1, Math.ceil(failure.retryAfterMs / 1000));
}

function upstreamStatus(error: any): number | undefined {
  const frame = error?.upstream ?? error;
  const value = frame?.status ?? frame?.status_code ?? frame?.response?.status ?? error?.status;
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function retryAfterMs(error: any): number | undefined {
  const frame = error?.upstream ?? error;
  const value = frame?.headers?.['retry-after'] ?? frame?.headers?.['Retry-After'] ?? frame?.retry_after;
  if (typeof value === 'number' && Number.isFinite(value)) return value * 1000;
  if (typeof value === 'string') {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return seconds * 1000;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return date - Date.now();
  }
  return undefined;
}

/**
 * Classify only image dispatch outcomes. This is intentionally conservative:
 * an uncertain POST is never replayed, but a future distinct request may use
 * another worker after a short, worker-scoped circuit opens when the failure
 * proves that target is unhealthy. An unknown outcome remains request-scoped:
 * it is terminal for the current mutation, but it does not prove that future
 * work cannot use the target.
 */
export function classifyImageRelayFailure(error: unknown): PrivateRelayFailure {
  const typed = error as any;
  const frame = typed?.upstream ?? typed ?? {};
  const status = upstreamStatus(typed);
  const code = String(typed?.code ?? frame?.error?.code ?? frame?.response?.error?.code ?? frame?.code ?? '').toLowerCase();
  const message = String(typed?.message ?? '').toLowerCase();
  const retry = retryAfterMs(typed);

  if (code.includes('invalid_request') || code.includes('invalid_argument')) {
    return privateRelayFailure({ class: 'request_rejected', scope: 'request' });
  }
  if (code === 'codex_image_invalid_artifact' || code === 'codex_image_invalid_response'
    || code === 'codex_image_response_limit' || code === 'codex_image_missing_body') {
    return privateRelayFailure({ class: 'invalid_upstream_response', scope: 'worker', retryAfterMs: 30_000 });
  }
  if (status === 401 || status === 403 || status === 404
    || /model_(?:not_allowed|not_found|permission_denied|not_authorized)|unsupported_model/.test(code)) {
    return privateRelayFailure({ class: 'capability_denied', scope: 'worker', retryAfterMs: 120_000 });
  }
  if (/model_(?:temporarily_unavailable|unavailable|disabled)/.test(code)) {
    return privateRelayFailure({ class: 'capability_temporarily_unavailable', scope: 'worker', retryAfterMs: 30_000 });
  }
  const responseRejectedBeforeGeneration = frame?.type === 'response.failed'
    && /rate[_ -]?limit|too many requests|quota|usage_limit|capacity/.test(code);
  if (status === 429 || responseRejectedBeforeGeneration) {
    // This class is only emitted for an image target rejection. It is the
    // private handoff that permits the owning pool to choose another worker;
    // ordinary/ambiguous failures keep their existing classes.
    return privateRelayFailure({ class: 'pre_generation_rejected', scope: 'worker', retryAfterMs: retry ?? 30_000 });
  }
  if (status === 408 || status === 504 || /timeout|timed out|deadline/.test(code) || /timeout|timed out|deadline/.test(message)) {
    return privateRelayFailure({ class: 'upstream_timeout', scope: 'worker', retryAfterMs: retry ?? 10_000 });
  }
  if (status !== undefined && status >= 500) {
    return privateRelayFailure({ class: 'upstream_unavailable', scope: 'worker', retryAfterMs: retry ?? 5_000 });
  }
  return privateRelayFailure({ class: 'unknown', scope: 'request', retryAfterMs: retry ?? 5_000 });
}

export function fleetRelayFailure(retryAfterMs?: number): PrivateRelayFailure {
  return privateRelayFailure({ class: 'fleet_unavailable', scope: 'fleet', retryAfterMs });
}
