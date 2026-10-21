import type {
  TokenBucketState,
  SlidingWindowQuotaState
} from './pool-contracts.js';

/**
 * Enterprise Dual-Window Mathematical Rate Governor for GALXAI.
 *
 * Implements:
 * 1. Token Bucket calculus: Continuous fractional token & request replenishment with microsecond precision.
 * 2. Sliding-Window Log calculus: Exact discrete request window modeling (e.g. 5 requests / 5 hours,
 *    40 requests / 3 hours) with rolling timestamp log and circular pruning.
 * 3. Out-of-band quota resynchronization.
 * 4. Natural language duration & time extractor ("4 hours 12 minutes", "resets at 3:45 PM", ISO 8601, epochs).
 * 5. Authoritative upstream rate-limit header reconciliation.
 */
export class ContinuousTokenBucketRateGovernor {
  /**
   * Deep natural language duration & timestamp parser.
   * Handles:
   * - Natural text: "4 hours 12 minutes", "5h30m", "in 45 seconds", "try again in 280s"
   * - Time references: "resets at 3:45 PM", "resets at 16:30:00"
   * - Numeric strings & pure seconds / millisecond epochs
   * - ISO 8601 dates & HTTP-date strings
   */
  public static parseDurationToMs(value: string | number | undefined, nowMs = Date.now()): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'number') {
      if (value > 100_000_000_000) {
        return Math.max(0, value - nowMs);
      }
      return Math.max(0, value * 1000);
    }

    const rawStr = String(value).trim();
    if (!rawStr) return undefined;

    // Pure number string
    if (/^\d+(\.\d+)?$/.test(rawStr)) {
      const num = parseFloat(rawStr);
      if (num > 100_000_000_000) {
        return Math.max(0, num - nowMs);
      }
      return Math.max(0, num * 1000);
    }

    const str = rawStr.toLowerCase();

    // Check for "resets at HH:MM(:SS) (AM|PM)?" or "at HH:MM"
    const timeMatch = str.match(/(?:at|resets\s+at)\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1], 10);
      const minutes = parseInt(timeMatch[2], 10);
      const seconds = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
      const meridiem = timeMatch[4] ? timeMatch[4].toLowerCase() : null;

      if (meridiem === 'pm' && hours < 12) hours += 12;
      if (meridiem === 'am' && hours === 12) hours = 0;

      const targetDate = new Date(nowMs);
      targetDate.setHours(hours, minutes, seconds, 0);

      // If target time is earlier today, assume it's tomorrow
      if (targetDate.getTime() <= nowMs) {
        targetDate.setDate(targetDate.getDate() + 1);
      }

      return Math.max(0, targetDate.getTime() - nowMs);
    }

    // Units parsing: days, hours, minutes/mins, seconds/secs, ms
    let totalMs = 0;
    let matched = false;

    const days = str.match(/(\d+(?:\.\d+)?)\s*(?:d|days?)/i);
    if (days) { totalMs += parseFloat(days[1]) * 86400000; matched = true; }

    const hours = str.match(/(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)/i);
    if (hours) { totalMs += parseFloat(hours[1]) * 3600000; matched = true; }

    const mins = str.match(/(\d+(?:\.\d+)?)\s*(?:m|mins?|minutes?)(?!s)/i);
    if (mins) { totalMs += parseFloat(mins[1]) * 60000; matched = true; }

    const secs = str.match(/(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)/i);
    if (secs) { totalMs += parseFloat(secs[1]) * 1000; matched = true; }

    const ms = str.match(/(\d+(?:\.\d+)?)\s*ms/i);
    if (ms) { totalMs += parseFloat(ms[1]); matched = true; }

    if (matched) return totalMs;

    // HTTP-date / ISO date
    const parsedDate = Date.parse(rawStr);
    if (!isNaN(parsedDate) && parsedDate > nowMs) {
      return parsedDate - nowMs;
    }

    return undefined;
  }

  /**
   * Creates a default token bucket initialized with full capacity.
   */
  createDefaultBucket(
    maxTokens = 300_000,
    refillRatePerMinute = 300_000,
    maxRequests = 500,
    nowMs = Date.now()
  ): TokenBucketState {
    return {
      maxTokens,
      remainingTokens: maxTokens,
      refillRatePerMinute,
      maxRequests,
      remainingRequests: maxRequests,
      lastRefillTimestampMs: nowMs,
      reservedTokens: 0
    };
  }

  /**
   * Creates a default sliding window quota state (e.g. 5 requests per 5 hours).
   */
  createDefaultSlidingWindow(
    windowDurationMs = 5 * 3600 * 1000, // 5 hours
    maxRequestsPerWindow = 5,
    nowMs = Date.now()
  ): SlidingWindowQuotaState {
    return {
      windowDurationMs,
      maxRequestsPerWindow,
      usedRequestsInWindow: 0,
      windowStartTimestampMs: nowMs,
      requestHistoryTimestampsMs: []
    };
  }

  /**
   * Cleans expired request timestamps outside the active rolling window [nowMs - windowDurationMs, nowMs].
   */
  cleanExpiredSlidingWindowTimestamps(
    quota: SlidingWindowQuotaState,
    nowMs = Date.now()
  ): SlidingWindowQuotaState {
    const windowDuration = quota.windowDurationMs || 5 * 3600 * 1000;
    const cutoffTimestamp = nowMs - windowDuration;
    const history = quota.requestHistoryTimestampsMs || [];

    const activeTimestamps = history.filter((ts) => ts > cutoffTimestamp);

    return {
      ...quota,
      requestHistoryTimestampsMs: activeTimestamps,
      usedRequestsInWindow: activeTimestamps.length,
      windowStartTimestampMs: activeTimestamps.length > 0 ? Math.min(...activeTimestamps) : nowMs
    };
  }

  /**
   * Evaluates if a sliding window quota has available capacity.
   */
  canConsumeSlidingWindow(
    quota: SlidingWindowQuotaState,
    requiredRequests = 1,
    nowMs = Date.now()
  ): { canConsume: boolean; remainingRequests: number; resetInMs: number } {
    const cleaned = this.cleanExpiredSlidingWindowTimestamps(quota, nowMs);
    const maxAllowed = cleaned.dynamicDiscoveredCap ?? cleaned.maxRequestsPerWindow;
    const remaining = Math.max(0, maxAllowed - cleaned.usedRequestsInWindow);

    let resetInMs = 0;
    if (cleaned.requestHistoryTimestampsMs.length > 0) {
      const oldestActive = cleaned.requestHistoryTimestampsMs[0];
      const windowExpiresAt = oldestActive + cleaned.windowDurationMs;
      resetInMs = Math.max(0, windowExpiresAt - nowMs);
    }

    return {
      canConsume: remaining >= requiredRequests,
      remainingRequests: remaining,
      resetInMs
    };
  }

  /**
   * Atomically records request consumption in the sliding window log.
   */
  recordSlidingWindowConsumption(
    quota: SlidingWindowQuotaState,
    requestsConsumed = 1,
    nowMs = Date.now()
  ): SlidingWindowQuotaState {
    const cleaned = this.cleanExpiredSlidingWindowTimestamps(quota, nowMs);
    const newTimestamps = [...cleaned.requestHistoryTimestampsMs];
    for (let i = 0; i < requestsConsumed; i++) {
      newTimestamps.push(nowMs);
    }

    return {
      ...cleaned,
      requestHistoryTimestampsMs: newTimestamps,
      usedRequestsInWindow: newTimestamps.length
    };
  }

  /**
   * Out-of-Band Sync: When an external 429 occurs, syncs the sliding window to full exhaustion
   * until the authoritative upstream reset timestamp.
   */
  syncSlidingWindowFromReset(
    quota: SlidingWindowQuotaState,
    resetAtTimestampMs: number,
    discoveredCap?: number,
    nowMs = Date.now()
  ): SlidingWindowQuotaState {
    const duration = quota.windowDurationMs || 5 * 3600 * 1000;
    const impliedOldestTimestamp = resetAtTimestampMs - duration;
    const maxCap = discoveredCap ?? quota.maxRequestsPerWindow;

    // Synthesize timestamps filling the window
    const syntheticTimestamps: number[] = [];
    for (let i = 0; i < maxCap; i++) {
      syntheticTimestamps.push(impliedOldestTimestamp + (i * 1000));
    }

    return {
      ...quota,
      maxRequestsPerWindow: maxCap,
      dynamicDiscoveredCap: discoveredCap,
      usedRequestsInWindow: maxCap,
      requestHistoryTimestampsMs: syntheticTimestamps,
      lastExhaustionResetAtMs: resetAtTimestampMs
    };
  }

  /**
   * Continuously calculates fractional replenished tokens and requests over elapsed time.
   * Preserves fractional remainders to eliminate rounding starvation on rapid sub-millisecond queries.
   */
  refillBucket(bucket: TokenBucketState, nowMs = Date.now()): TokenBucketState {
    const lastRefill = bucket.lastRefillTimestampMs || nowMs;
    // Guard against clock skew / NTP synchronization adjusting backwards
    if (nowMs <= lastRefill) {
      return bucket;
    }

    const elapsedMs = nowMs - lastRefill;
    const elapsedMinutes = elapsedMs / 60000.0;

    const tokensToAdd = elapsedMinutes * (bucket.refillRatePerMinute || bucket.maxTokens);
    const requestsToAdd = elapsedMinutes * (bucket.maxRequests || 500);

    const newTokens = Math.min(bucket.maxTokens, bucket.remainingTokens + tokensToAdd);
    const newRequests = Math.min(bucket.maxRequests, bucket.remainingRequests + requestsToAdd);

    return {
      ...bucket,
      remainingTokens: Math.min(bucket.maxTokens, Math.max(0, Math.floor(newTokens * 1000) / 1000)),
      remainingRequests: Math.min(bucket.maxRequests, Math.max(0, Math.floor(newRequests * 1000) / 1000)),
      lastRefillTimestampMs: nowMs,
    };
  }

  /**
   * Non-mutating probe: checks if bucket has sufficient unreserved tokens and request capacity.
   */
  canConsume(
    bucket: TokenBucketState,
    requiredTokens = 1,
    requiredRequests = 1,
    nowMs = Date.now()
  ): boolean {
    const updated = this.refillBucket(bucket, nowMs);
    const availableUnreservedTokens = Math.max(0, updated.remainingTokens - (updated.reservedTokens || 0));
    return availableUnreservedTokens >= requiredTokens && updated.remainingRequests >= requiredRequests;
  }

  /**
   * Phase 1: Reserves estimated tokens for an in-flight lease to prevent concurrent over-commitment.
   */
  reserve(
    bucket: TokenBucketState,
    tokensToReserve: number,
    nowMs = Date.now()
  ): { bucket: TokenBucketState; reserved: boolean } {
    const updated = this.refillBucket(bucket, nowMs);
    const available = Math.max(0, updated.remainingTokens - (updated.reservedTokens || 0));

    if (available >= tokensToReserve) {
      return {
        bucket: {
          ...updated,
          reservedTokens: (updated.reservedTokens || 0) + tokensToReserve
        },
        reserved: true
      };
    }
    return { bucket: updated, reserved: false };
  }

  /**
   * Phase 2: Commits actual token consumption and releases soft reservation.
   */
  commit(
    bucket: TokenBucketState,
    tokensConsumed: number,
    reservedTokensHeld = 0,
    requestsConsumed = 1,
    nowMs = Date.now()
  ): TokenBucketState {
    const updated = this.refillBucket(bucket, nowMs);
    const newRemainingTokens = Math.max(0, Math.floor((updated.remainingTokens - tokensConsumed) * 1000) / 1000);
    const newReservedTokens = Math.max(0, (updated.reservedTokens || 0) - reservedTokensHeld);
    const newRemainingRequests = Math.max(0, Math.floor((updated.remainingRequests - requestsConsumed) * 1000) / 1000);

    return {
      ...updated,
      remainingTokens: newRemainingTokens,
      reservedTokens: newReservedTokens,
      remainingRequests: newRemainingRequests,
      lastRefillTimestampMs: nowMs
    };
  }

  /**
   * Atomically consumes tokens and request slots with continuous mathematical replenishment.
   */
  consume(
    bucket: TokenBucketState,
    tokensToConsume: number,
    requestsToConsume = 1,
    nowMs = Date.now()
  ): { bucket: TokenBucketState; consumed: boolean } {
    const updated = this.refillBucket(bucket, nowMs);
    const available = Math.max(0, updated.remainingTokens - (updated.reservedTokens || 0));

    if (available >= tokensToConsume && updated.remainingRequests >= requestsToConsume) {
      return {
        bucket: {
          ...updated,
          remainingTokens: Math.max(0, Math.floor((updated.remainingTokens - tokensToConsume) * 1000) / 1000),
          remainingRequests: Math.max(0, Math.floor((updated.remainingRequests - requestsToConsume) * 1000) / 1000),
        },
        consumed: true,
      };
    }
    return { bucket: updated, consumed: false };
  }

  /**
   * Reconciles internal token bucket capacity against authoritative upstream rate limit response headers
   * from OpenAI (`x-ratelimit-remaining-tokens`, `x-ratelimit-remaining-requests`, `x-ratelimit-reset-tokens`).
   */
  reconcileWithUpstreamHeaders(
    bucket: TokenBucketState,
    headers: Record<string, string | number | undefined>,
    nowMs = Date.now()
  ): TokenBucketState {
    const remainingTokensHeader =
      headers['x-ratelimit-remaining-tokens'] ||
      headers['x-ratelimit-remaining-tokens-usage'] ||
      headers['x-ratelimit-tokens-remaining'];

    const remainingRequestsHeader =
      headers['x-ratelimit-remaining-requests'] ||
      headers['x-ratelimit-requests-remaining'];

    const limitTokensHeader =
      headers['x-ratelimit-limit-tokens'] ||
      headers['x-ratelimit-tokens-limit'];

    const limitRequestsHeader =
      headers['x-ratelimit-limit-requests'] ||
      headers['x-ratelimit-requests-limit'];

    const resetTokensHeader =
      headers['x-ratelimit-reset-tokens'] ||
      headers['x-ratelimit-tokens-reset'];

    let newTokens = bucket.remainingTokens;
    let newRequests = bucket.remainingRequests;
    let maxTokens = bucket.maxTokens;
    let maxRequests = bucket.maxRequests;
    let refillRate = bucket.refillRatePerMinute;

    if (limitTokensHeader !== undefined) {
      const parsedMax = Number(limitTokensHeader);
      if (!isNaN(parsedMax) && parsedMax > 0) {
        maxTokens = parsedMax;
      }
    }

    if (limitRequestsHeader !== undefined) {
      const parsedMaxReq = Number(limitRequestsHeader);
      if (!isNaN(parsedMaxReq) && parsedMaxReq > 0) {
        maxRequests = parsedMaxReq;
      }
    }

    if (remainingTokensHeader !== undefined) {
      const parsedTokens = Number(remainingTokensHeader);
      if (!isNaN(parsedTokens) && parsedTokens >= 0) {
        newTokens = Math.min(maxTokens, parsedTokens);
      }
    }

    if (remainingRequestsHeader !== undefined) {
      const parsedRequests = Number(remainingRequestsHeader);
      if (!isNaN(parsedRequests) && parsedRequests >= 0) {
        newRequests = Math.min(maxRequests, parsedRequests);
      }
    }

    // Dynamic refill rate recalibration based on upstream reset window
    if (resetTokensHeader !== undefined) {
      const resetMs = ContinuousTokenBucketRateGovernor.parseDurationToMs(resetTokensHeader, nowMs);
      if (resetMs && resetMs > 500) {
        const tokensToRefill = maxTokens - newTokens;
        if (tokensToRefill > 0) {
          const calculatedRatePerMinute = (tokensToRefill / (resetMs / 60000.0));
          refillRate = Math.max(10_000, Math.round(calculatedRatePerMinute));
        }
      }
    }

    return {
      maxTokens,
      maxRequests,
      refillRatePerMinute: refillRate || maxTokens,
      remainingTokens: Math.max(0, Math.min(maxTokens, newTokens)),
      reservedTokens: Math.min(newTokens, bucket.reservedTokens || 0),
      remainingRequests: Math.max(0, Math.min(maxRequests, newRequests)),
      lastRefillTimestampMs: nowMs,
    };
  }
}

export const NovaRateGovernor = ContinuousTokenBucketRateGovernor;
export type NovaRateGovernor = ContinuousTokenBucketRateGovernor;

