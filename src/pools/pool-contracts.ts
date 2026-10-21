/**
 * Core Universal Gateway Contracts for Inference Quota & Shard Pooling
 */

export type ProviderType = 'openai' | 'galx' | 'anthropic' | 'custom';
export type ShardIsolationMode = 'private' | 'pooled';
export type CredentialStatus =
  | 'healthy'
  | 'warming_up'
  | 'half_open'
  | 'cooldown'
  | 'exhausted'
  | 'dead'
  | 'paused'
  | 'revoked'
  | 'soft_draining'
  | 'quarantined';

export type GalxRotationStrategy =
  | 'adaptive_headroom'
  | 'smooth_weighted_round_robin'
  | 'least_utilized'
  | 'priority_failover';

export type AuthType = 'oauth' | 'api_key';

export interface SlidingWindowQuotaState {
  readonly windowDurationMs: number;
  readonly maxRequestsPerWindow: number;
  readonly usedRequestsInWindow: number;
  readonly windowStartTimestampMs: number;
  readonly requestHistoryTimestampsMs: number[];
  readonly dynamicDiscoveredCap?: number;
  readonly lastExhaustionResetAtMs?: number;
}

export type FailureClassificationCategory =
  | 'request_rejected'
  | 'cancelled'
  | 'rolling_window_exhausted'
  | 'tpm_rpm_rate_limited'
  | 'billing_depleted'
  | 'model_incompatible'
  | 'auth_terminal'
  | 'origin_overloaded'
  | 'socket_timeout'
  | 'transient_5xx'
  | 'unknown';

export interface TokenBucketState {
  readonly maxTokens: number;
  readonly remainingTokens: number;
  readonly refillRatePerMinute: number;
  readonly maxRequests: number;
  readonly remainingRequests: number;
  readonly lastRefillTimestampMs: number;
  readonly reservedTokens?: number;
}

export interface ShardUsageStats {
  readonly totalRequestsServed: number;
  readonly totalTokensConsumed: number;
  readonly consecutiveFailures: number;
  readonly consecutiveSuccesses?: number;
  readonly lastUsedTimestampMs?: number;
  readonly averageLatencyMs?: number;
  readonly lastLatencyMs?: number;
  readonly successfulRequests?: number;
  readonly failedRequests?: number;
}

export interface EncryptedSecretPayload {
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
  readonly keyVersion?: string;
}

export interface DecryptedGalxSecret {
  readonly accessToken?: string;
  readonly apiKey?: string;
  readonly refreshToken?: string;
  readonly expiresAtMs?: number;
  readonly accountId?: string;
  readonly tenantUid?: string;
  readonly email?: string;
  readonly name?: string;
}

export interface PrivacyCapabilities {
  readonly hipaaCompliant: boolean;
  readonly zdrCertified: boolean;
  readonly dataResidency: 'global' | 'eu' | 'us' | 'apac' | 'latam' | 'ca' | 'ch' | 'uk';
  readonly baaSigned: boolean;
  readonly piiFiltering: boolean;
}

export interface GalxShardAccount {
  readonly id: string;
  readonly userId: string;
  readonly provider: ProviderType;
  readonly authType: AuthType;
  readonly accountLabel: string;
  readonly apiKeyMasked: string;
  readonly encryptedPayload?: EncryptedSecretPayload;
  readonly encryptedSecrets?: EncryptedSecretPayload;
  readonly shardMode?: ShardIsolationMode;
  readonly priority: number;
  readonly weight: number;
  readonly status: CredentialStatus;
  readonly tokenBucket: TokenBucketState;
  readonly stats: ShardUsageStats;
  readonly privacyCapabilities?: PrivacyCapabilities;
  readonly fencingToken?: number;
  readonly permissionRetracted?: boolean;
  readonly expiresAtMs?: number;
  readonly accountId?: string;
  readonly cooldownUntilMs?: number;
  readonly cooldownUntilTimestampMs?: number;
  readonly slidingWindowQuota?: SlidingWindowQuotaState;
  readonly supportedModels?: string[];
  readonly unsupportedModels?: string[];
  readonly flappingCount?: number;
  readonly lastFlappedAtMs?: number;
  readonly outOfBandUsageDetectedAtMs?: number;
  readonly warmupStartedAtMs?: number;
  readonly adaptiveInFlightLimit?: number;
  readonly registryRevision?: number;
  readonly managedDesktopId?: string;
  readonly desktopEnrolledAt?: string;
  readonly registrySource?: 'api' | 'oauth' | 'operator_import' | 'environment_bootstrap' | 'legacy_migration';
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ShardLease {
  readonly leaseId: string;
  readonly shardId: string;
  readonly userId: string;
  readonly jobId?: string;
  readonly fencingToken: number;
  readonly acquiredAtMs: number;
  expiresAtMs: number;
  readonly estimatedTokens: number;
  readonly account: GalxShardAccount;
}

export interface ShardAcquisitionRequest {
  readonly userId: string;
  readonly jobId?: string;
  readonly provider: ProviderType;
  readonly estimatedTokens?: number;
  readonly isPriorityUser?: boolean;
  readonly maxTenantPooledInFlight?: number;
  readonly leaseTtlMs?: number;
  readonly maxInFlightPerShard?: number;
  readonly targetModel?: string;
  readonly nowMs?: number;
  readonly targetAccountId?: string;
  readonly targetShardId?: string;
  readonly queueIfExhausted?: boolean;
  readonly maxQueueWaitMs?: number;
  readonly signal?: AbortSignal;
  readonly idempotencyKey?: string;
  readonly tenantId?: string;
  readonly deadlineMs?: number;
  readonly hipaaRequired?: boolean;
  readonly privacyProfile?: string;
  readonly dataResidency?: string;
  readonly zdrRequired?: boolean;
}

export interface ShardAcquisitionResult {
  readonly lease?: ShardLease;
  readonly reason?: string;
  readonly status?:
    | 'tenant_pool_quota_capped'
    | 'all_shards_cooldown'
    | 'no_healthy_shards'
    | 'success'
    | 'pool_exhausted'
    | 'privacy_policy_mismatch'
    | 'no_compliant_shards'
    | 'queued'
    | 'queue_timeout'
    | 'cancelled'
    | 'shed_overflow'
    | 'invalid_request'
    | 'authority_unavailable';
  readonly queuedPromise?: Promise<ShardAcquisitionResult>;
  readonly estimatedWaitMs?: number;
  readonly earliestPoolResetMs?: number;
}

export interface CircuitEvaluationResult {
  readonly status: CredentialStatus;
  readonly canAttempt: boolean;
  readonly cooldownMs?: number;
  readonly canaryMultiplier?: number;
  readonly isCanaryCandidate?: boolean;
  readonly remainingWindowRequests?: number;
  readonly windowResetMs?: number;
}

export interface CircuitFailureClassification {
  readonly affectsHealth?: boolean;
  readonly newStatus: CredentialStatus;
  readonly cooldownMs?: number;
  readonly reason: string;
  readonly isPermanent?: boolean;
  readonly category?: FailureClassificationCategory;
  readonly resetAtTimestampMs?: number;
  readonly retryAfterSeconds?: number;
}

export interface PoolStats {
  readonly totalShards: number;
  readonly healthyShards: number;
  readonly cooldownShards: number;
  readonly exhaustedShards: number;
  readonly deadShards?: number;
  readonly totalTokensAvailable?: number;
  readonly totalMaxTokens?: number;
  readonly totalRequestsServed?: number;
  readonly totalTokensConsumed?: number;
  readonly totalTokensServedLifetime?: number;
  readonly totalRequestsServedLifetime?: number;
  readonly tokensPerMinuteThroughput?: number;
  readonly averageFleetLatencyMs?: number;
  readonly activeLeases?: number;
  readonly activeLeasesCount?: number;
  readonly rotationStrategy: GalxRotationStrategy;
  readonly totalPooledShards?: number;
  readonly totalPrivateShards?: number;
  readonly providerBreakdown?: Record<string, { total: number; healthy: number }>;
}

export type NovaShardAccount = GalxShardAccount;
export type NovaRotationStrategy = GalxRotationStrategy;
export type NovaSecret = DecryptedGalxSecret;
