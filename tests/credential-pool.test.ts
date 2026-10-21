import assert from 'node:assert/strict';
import test from 'node:test';
import { NovaCredentialPool } from '../src/pools/credential-pool.js';
import { NovaCredentialSubstrate } from '../src/pools/credential-substrate.js';
import { NovaRateGovernor } from '../src/pools/rate-governor.js';
import { NovaCircuitBreaker } from '../src/pools/circuit-breaker.js';
import type { NovaShardAccount } from '../src/pools/pool-contracts.js';

function createMockShard(id: string, weight = 1, priority = 10, maxTokens = 100_000): NovaShardAccount {
  const now = Date.now();
  return {
    id,
    userId: 'admin',
    accountLabel: `Shard ${id}`,
    provider: 'openai',
    authType: 'api_key',
    shardMode: 'pooled',
    status: 'healthy',
    priority,
    weight,
    apiKeyMasked: 'sk-proj...mock',
    tokenBucket: {
      maxTokens,
      remainingTokens: maxTokens,
      refillRatePerMinute: 60_000,
      maxRequests: 500,
      remainingRequests: 500,
      lastRefillTimestampMs: now,
      reservedTokens: 0
    },
    stats: {
      totalRequestsServed: 0,
      totalTokensConsumed: 0,
      consecutiveFailures: 0
    },
    createdAtMs: now,
    updatedAtMs: now
  };
}

test('NovaRateGovernor calculates sliding window limits and parses durations', () => {
  const governor = new NovaRateGovernor();
  const now = Date.now();

  let slidingQuota = governor.createDefaultSlidingWindow(5 * 3600 * 1000, 5, now);
  for (let i = 0; i < 5; i++) {
    const evalCheck = governor.canConsumeSlidingWindow(slidingQuota, 1, now + (i * 100));
    assert.strictEqual(evalCheck.canConsume, true);
    slidingQuota = governor.recordSlidingWindowConsumption(slidingQuota, 1, now + (i * 100));
  }
  assert.strictEqual(slidingQuota.usedRequestsInWindow, 5);

  const eval6th = governor.canConsumeSlidingWindow(slidingQuota, 1, now + 1000);
  assert.strictEqual(eval6th.canConsume, false);

  // Natural duration parsing
  assert.equal(NovaRateGovernor.parseDurationToMs('15 seconds', now), 15_000);
  assert.equal(NovaRateGovernor.parseDurationToMs('2 hours 30 minutes', now), 2.5 * 3600 * 1000);
});

test('NovaCircuitBreaker dissects upstream errors and manages canary slots', () => {
  const circuitBreaker = new NovaCircuitBreaker();
  const now = Date.now();

  // 1. Canary slot isolation
  const first = circuitBreaker.acquireCanarySlot('shard_test');
  assert.strictEqual(first, true);
  const second = circuitBreaker.acquireCanarySlot('shard_test');
  assert.strictEqual(second, false);
  circuitBreaker.releaseCanarySlot('shard_test');
  assert.strictEqual(circuitBreaker.acquireCanarySlot('shard_test'), true);
  circuitBreaker.releaseCanarySlot('shard_test');

  // 2. Dissect 429 error
  const classification = circuitBreaker.dissectUpstreamError(
    429,
    'Usage limit reached. Try again in 4 hours 15 minutes',
    undefined,
    now
  );
  assert.strictEqual(classification.newStatus, 'exhausted');
  assert.strictEqual(classification.category, 'rolling_window_exhausted');
});

test('NovaCredentialPool leases accounts using Smooth Weighted Round Robin (SWRR)', () => {
  const substrate = new NovaCredentialSubstrate();
  const rateGovernor = new NovaRateGovernor();
  const circuitBreaker = new NovaCircuitBreaker();
  const pool = new NovaCredentialPool(substrate, rateGovernor, circuitBreaker, 'smooth_weighted_round_robin');

  substrate.addAccount(createMockShard('shard_A', 2));
  substrate.addAccount(createMockShard('shard_B', 1));

  const picks: string[] = [];
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    const res = pool.acquireLease({
      userId: 'test_user',
      provider: 'openai',
      estimatedTokens: 100
    }, now + i * 10);
    assert.ok(res.lease);
    picks.push(res.lease.shardId);
    pool.releaseLease(res.lease.leaseId, { success: true, tokensConsumed: 100 });
  }

  const countA = picks.filter(p => p === 'shard_A').length;
  const countB = picks.filter(p => p === 'shard_B').length;
  assert.equal(countA, 4);
  assert.equal(countB, 2);
});

test('NovaCredentialPool handles token reservation and release', () => {
  const substrate = new NovaCredentialSubstrate();
  const pool = new NovaCredentialPool(substrate);

  const shard = createMockShard('shard_res', 1, 10, 50_000);
  substrate.addAccount(shard);

  const now = Date.now();
  const res = pool.acquireLease({
    userId: 'user_1',
    provider: 'openai',
    estimatedTokens: 10_000
  }, now);

  assert.ok(res.lease);
  assert.equal(res.lease.estimatedTokens, 10_000);

  pool.releaseLease(res.lease.leaseId, {
    success: false,
    tokensConsumed: 0,
    healthImpact: 'neutral'
  });

  const updated = substrate.getAccount('shard_res');
  assert.ok(updated);
  assert.equal(updated.stats.totalTokensConsumed, 0);
});
