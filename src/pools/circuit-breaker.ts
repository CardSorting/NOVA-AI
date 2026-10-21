import type {
  GalxShardAccount,
  CredentialStatus,
  CircuitEvaluationResult,
  CircuitFailureClassification,
  FailureClassificationCategory
} from './pool-contracts.js';
import { ContinuousTokenBucketRateGovernor } from './rate-governor.js';

const TERMINAL_AUTH_ERRORS: readonly string[] = [
  'token_invalidated',
  'token_revoked',
  'invalid_token',
  'invalid_grant',
  'unauthorized_client',
  'account_deactivated',
  'insufficient_quota_permanent',
  'invalid_api_key',
  'incorrect api key',
  'invalid api key',
  'billing_not_active',
  'quota_exceeded_permanent',
  'permission_revoked',
  'authentication_error'
];

const MODEL_INCOMPATIBLE_ERRORS: readonly string[] = [
  'model_not_found',
  'unsupported_model',
  'does not exist or you do not have access',
  'the model does not support',
  'unsupported parameter for model',
  'model_permission_denied',
  'invalid_model_for_tier',
  'model not available'
];

const BILLING_EXHAUSTION_ERRORS: readonly string[] = [
  'insufficient_quota',
  'check your plan and billing details',
  'billing_hard_limit_reached',
  'account_payment_past_due',
  'unpaid_invoice',
  'payment_required'
];

/**
 * Enterprise 6-State Resilient Circuit Breaker with Deep Error Dissection,
 * Strict Single-Canary Slotting, and Slow-Start Quadratic Warmup.
 *
 * States:
 * - `healthy`: Normal execution capacity (100% throughput).
 * - `warming_up`: Slow-Start warmup curve $(t/T)^2$ preventing post-cooldown thundering herd.
 * - `half_open`: Strict single-canary probe slot.
 * - `cooldown`: Temporary exponential backoff with full decorrelated jitter on 429/503.
 * - `exhausted`: Extended backoff on dense failures (>5) or rolling window exhaustion (5/hr).
 * - `soft_draining`: Preemptively drops priority when remaining quota < 5%.
 * - `dead`: Permanently invalidated authorization keys (401/403/revocation).
 * - `quarantined`: Billing exhaustion / past-due accounts.
 * - `paused` / `revoked`: Administratively deactivated.
 */
export class GalxCircuitBreaker {
  private readonly activeCanarySlots = new Set<string>();
  private readonly shardModelBlacklist = new Map<string, Set<string>>();
  private readonly WARMUP_DURATION_MS = 30_000; // 30 seconds slow-start warmup

  /**
   * Checks if an error is a permanent terminal auth error requiring immediate shard eviction.
   */
  isTerminalAuthError(errorReason: string): boolean {
    if (!errorReason) return false;
    const lower = errorReason.toLowerCase();
    for (const term of TERMINAL_AUTH_ERRORS) {
      if (new RegExp(`(^|[^a-z0-9_])${term}([^a-z0-9_]|$)`, 'i').test(lower)) {
        return true;
      }
    }
    return false;
  }

  isPermanentFailure(errorReason: string): boolean {
    return this.isTerminalAuthError(errorReason);
  }

  /**
   * Registers a model as unsupported by a specific shard to prevent future incompatible routes.
   */
  public blacklistModelForShard(shardId: string, modelId: string): void {
    if (!this.shardModelBlacklist.has(shardId)) {
      this.shardModelBlacklist.set(shardId, new Set<string>());
    }
    this.shardModelBlacklist.get(shardId)!.add(modelId.toLowerCase());
  }

  /**
   * Checks if a shard supports a specific model.
   */
  public isModelSupportedByShard(shardId: string, modelId?: string, account?: GalxShardAccount): boolean {
    if (!modelId) return true;
    const lowerModel = modelId.toLowerCase();

    // Check in-memory blacklist
    if (this.shardModelBlacklist.get(shardId)?.has(lowerModel)) {
      return false;
    }

    // Check account-level explicit unsupported list
    if (account?.unsupportedModels?.some(m => m.toLowerCase() === lowerModel)) {
      return false;
    }

    // Check account-level explicit supported list
    if (account?.supportedModels && account.supportedModels.length > 0) {
      return account.supportedModels.some(m => m.toLowerCase() === lowerModel);
    }

    return true;
  }

  /**
   * Evaluates shard health against current timestamp, handling half-open canary probes and slow-start warmup.
   */
  evaluateAccountStatus(
    account: GalxShardAccount,
    nowMs = Date.now(),
    targetModel?: string
  ): CircuitEvaluationResult {
    if (account.permissionRetracted || account.status === 'revoked') {
      return { status: 'revoked', canAttempt: false, canaryMultiplier: 0 };
    }

    if (account.status === 'dead') {
      return { status: 'dead', canAttempt: false, canaryMultiplier: 0 };
    }

    if (account.status === 'paused') {
      return { status: 'paused', canAttempt: false, canaryMultiplier: 0 };
    }

    if (account.status === 'quarantined') {
      return { status: 'quarantined', canAttempt: false, canaryMultiplier: 0 };
    }

    // Check model capability blacklist
    if (targetModel && !this.isModelSupportedByShard(account.id, targetModel, account)) {
      return { status: 'quarantined', canAttempt: false, canaryMultiplier: 0 };
    }

    const cooldownUntil = account.cooldownUntilTimestampMs || account.cooldownUntilMs || 0;

    // Handle Sliding Window Quota (e.g. 5 requests / 5 hours)
    if (account.slidingWindowQuota) {
      const windowDuration = account.slidingWindowQuota.windowDurationMs || 5 * 3600 * 1000;
      const cutoff = nowMs - windowDuration;
      const history = (account.slidingWindowQuota.requestHistoryTimestampsMs || []).filter(ts => ts > cutoff);
      const maxRequests = account.slidingWindowQuota.dynamicDiscoveredCap ?? account.slidingWindowQuota.maxRequestsPerWindow;
      const remainingRequests = Math.max(0, maxRequests - history.length);

      let windowResetMs = 0;
      if (history.length > 0 && remainingRequests <= 0) {
        windowResetMs = Math.max(0, (history[0] + windowDuration) - nowMs);
        return {
          status: 'exhausted',
          canAttempt: false,
          cooldownMs: windowResetMs,
          canaryMultiplier: 0,
          remainingWindowRequests: 0,
          windowResetMs
        };
      }
    }

    if (account.status === 'exhausted') {
      if (cooldownUntil > 0 && nowMs >= cooldownUntil) {
        // Transition to Half-Open single canary probe
        const hasActiveCanary = this.activeCanarySlots.has(account.id);
        if (!hasActiveCanary) {
          return {
            status: 'half_open',
            canAttempt: true,
            canaryMultiplier: 0.25,
            isCanaryCandidate: true
          };
        }
        return {
          status: 'half_open',
          canAttempt: false,
          cooldownMs: 500,
          canaryMultiplier: 0
        };
      }
      return {
        status: 'exhausted',
        canAttempt: false,
        cooldownMs: Math.max(0, cooldownUntil - nowMs),
        canaryMultiplier: 0
      };
    }

    if (account.status === 'cooldown') {
      if (cooldownUntil > 0 && nowMs >= cooldownUntil) {
        // Transition to Half-Open
        const hasActiveCanary = this.activeCanarySlots.has(account.id);
        if (!hasActiveCanary) {
          return {
            status: 'half_open',
            canAttempt: true,
            canaryMultiplier: 0.5,
            isCanaryCandidate: true
          };
        }
        return {
          status: 'half_open',
          canAttempt: false,
          cooldownMs: 500,
          canaryMultiplier: 0
        };
      }
      return {
        status: 'cooldown',
        canAttempt: false,
        cooldownMs: Math.max(0, cooldownUntil - nowMs),
        canaryMultiplier: 0
      };
    }

    if (account.status === 'half_open') {
      const hasActiveCanary = this.activeCanarySlots.has(account.id);
      if (!hasActiveCanary) {
        return {
          status: 'half_open',
          canAttempt: true,
          canaryMultiplier: 0.5,
          isCanaryCandidate: true
        };
      }
      return {
        status: 'half_open',
        canAttempt: false,
        cooldownMs: 500,
        canaryMultiplier: 0
      };
    }

    if (account.status === 'warming_up') {
      const warmupStart = account.warmupStartedAtMs || nowMs - 5000;
      const elapsed = nowMs - warmupStart;
      if (elapsed >= this.WARMUP_DURATION_MS) {
        return { status: 'healthy', canAttempt: true, canaryMultiplier: 1.0 };
      }
      // Quadratic slow-start ramp: (t / T)^2
      const rampFactor = Math.min(1.0, Math.max(0.1, Math.pow(elapsed / this.WARMUP_DURATION_MS, 2)));
      return {
        status: 'warming_up',
        canAttempt: true,
        canaryMultiplier: rampFactor
      };
    }

    if (account.status === 'soft_draining') {
      return { status: 'soft_draining', canAttempt: true, canaryMultiplier: 0.15 };
    }

    return { status: 'healthy', canAttempt: true, canaryMultiplier: 1.0 };
  }

  /**
   * Reserves a single canary slot for half-open verification.
   */
  public acquireCanarySlot(shardId: string): boolean {
    if (this.activeCanarySlots.has(shardId)) return false;
    this.activeCanarySlots.add(shardId);
    return true;
  }

  /**
   * Releases a canary slot upon completion.
   */
  public releaseCanarySlot(shardId: string): void {
    this.activeCanarySlots.delete(shardId);
  }

  /**
   * Deep NLP & regex dissector for upstream errors across OpenAI, Anthropic, xAI, Cloudflare, and reverse proxies.
   */
  public dissectUpstreamError(
    statusCode: number,
    errorBody: string,
    headers?: Record<string, string | number | undefined>,
    nowMs = Date.now(),
    account?: GalxShardAccount
  ): CircuitFailureClassification {
    const rawError = (errorBody || '').toLowerCase();
    const neutral = (category: 'request_rejected' | 'cancelled' | 'model_incompatible', reason: string): CircuitFailureClassification => ({
      newStatus: account?.status || 'healthy', affectsHealth: false, isPermanent: false, category, reason
    });
    // Validate the scope of rejection before deciding an entire credential is bad.
    if (statusCode === 499 || /\b(client_disconnect|client_cancelled|request_cancelled|aborterror)\b/.test(rawError)) {
      return neutral('cancelled', 'Request cancelled; provider health unchanged.');
    }
    if (MODEL_INCOMPATIBLE_ERRORS.some(phrase => rawError.includes(phrase))) {
      return neutral('model_incompatible', 'This model or parameter is unavailable for the request.');
    }
    if (statusCode === 401 || this.isTerminalAuthError(rawError)) {
      return { newStatus: 'dead', isPermanent: true, category: 'auth_terminal', reason: 'Provider rejected the credential.' };
    }
    if (statusCode === 402 || BILLING_EXHAUSTION_ERRORS.some(phrase => rawError.includes(phrase))) {
      return { newStatus: 'quarantined', isPermanent: false, category: 'billing_depleted', cooldownMs: 86_400_000,
        reason: 'Provider billing capacity is unavailable.' };
    }
    if (statusCode >= 400 && statusCode < 500 && ![408, 429].includes(statusCode)) {
      return neutral('request_rejected', 'Request rejected; provider health unchanged.');
    }

    const normalizedHeaders = Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    // Explicit headers are authoritative. Never parse arbitrary IDs as durations.
    const headerDurations = ['retry-after', 'x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']
      .map(key => {
        const value = normalizedHeaders[key];
        if (value === undefined) return undefined;
        const text = String(value).trim();
        if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 1000;
        // Parse HTTP-date before natural units ("07 Sep" is not "7 seconds").
        if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), .* GMT$/.test(text)) {
          const date = Date.parse(text);
          return Number.isFinite(date) ? Math.max(0, date - nowMs) : undefined;
        }
        if (key !== 'retry-after' && /^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(text)) {
          return ContinuousTokenBucketRateGovernor.parseDurationToMs(text, nowMs);
        }
        return undefined;
      })
      .filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0);
    const bodyDuration = /(?:try again|retry|resets?) (?:in|after|at)\b/i.test(errorBody)
      ? ContinuousTokenBucketRateGovernor.parseDurationToMs(errorBody, nowMs) : undefined;
    const authoritativeCooldownMs = headerDurations.length ? Math.max(...headerDurations)
      : bodyDuration !== undefined && Number.isFinite(bodyDuration) ? bodyDuration : undefined;
    const withJitter = (base: number) => Math.ceil(base + Math.random() * Math.min(2000, base * 0.1));

    if (statusCode === 429 || /\b(rate[ _-]?limit(?:ed|_exceeded)?|usage_limit_reached|usage limit reached|too many requests)\b/.test(rawError)) {
      const rolling = /\b(usage limit|usage_limit(?:_reached)?|rolling.window|current quota)\b/.test(rawError);
      const cooldownMs = withJitter(Math.max(1000, authoritativeCooldownMs ?? (rolling ? 180_000 : 30_000)));
      return { newStatus: rolling ? 'exhausted' : 'cooldown', cooldownMs, isPermanent: false,
        category: rolling ? 'rolling_window_exhausted' : 'tpm_rpm_rate_limited', resetAtTimestampMs: nowMs + cooldownMs,
        reason: `Provider capacity is limited; retry after ${Math.ceil(cooldownMs / 1000)} seconds.` };
    }

    const previousFailureAt = account?.stats?.lastUsedTimestampMs || 0;
    const consecutive = (nowMs - previousFailureAt <= 60_000 ? account?.stats?.consecutiveFailures || 0 : 0) + 1;
    const recovering = ['half_open', 'cooldown', 'exhausted'].includes(account?.status || '');
    // A single unconfirmed 5xx/timeout should not eject an otherwise healthy account.
    // Explicit provider backoff and a failed half-open probe still open immediately.
    const shouldOpen = recovering || consecutive >= 3 || authoritativeCooldownMs !== undefined;
    if (!shouldOpen) {
      return { newStatus: account?.status || 'healthy', category: 'transient_5xx', isPermanent: false,
        reason: 'Transient provider failure observed; waiting for corroborating failures.' };
    }
    const cooldownMs = withJitter(Math.max(1000, authoritativeCooldownMs ?? Math.min(300_000, 15_000 * 2 ** Math.min(4, consecutive - 1))));
    return { newStatus: 'cooldown', cooldownMs, category: statusCode === 408 ? 'socket_timeout' : 'origin_overloaded',
      isPermanent: false, resetAtTimestampMs: nowMs + cooldownMs,
      reason: `Provider temporarily unavailable; retry after ${Math.ceil(cooldownMs / 1000)} seconds.` };
  }

  /**
   * Compatibility wrapper for classifyFailure.
   */
  classifyFailure(
    account: GalxShardAccount,
    errorReason: string,
    nowMs = Date.now(),
    retryAfterHeader?: string | number
  ): CircuitFailureClassification {
    const headers = retryAfterHeader !== undefined ? { 'retry-after': retryAfterHeader } : undefined;
    const explicitStatus = errorReason.match(/(?:HTTP\s+|status(?: code)?[\s:=]+|error\s*\()(\d{3})\b/i);
    const statusCode = explicitStatus ? Number(explicitStatus[1]) : 500;
    return this.dissectUpstreamError(statusCode, errorReason, headers, nowMs, account);
  }
}

export const NovaCircuitBreaker = GalxCircuitBreaker;
export type NovaCircuitBreaker = GalxCircuitBreaker;
