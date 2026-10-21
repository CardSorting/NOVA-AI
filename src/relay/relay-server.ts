/**
 * @file LUMI-NEW/src/relay/relay-server.ts
 * @description Hardened Enterprise VM Relay Server & WebSocket Streaming Gateway powered by BroccoliDB.
 *
 * Architecture & Security Hardening:
 * 1. Zero-Trust Security & API Key Authentication:
 *    - Constant-time timing-safe credential verification (crypto.timingSafeEqual) against side-channel attacks.
 *    - Hardware-grade AES-256-GCM envelope decryption for encrypted shard fleets (.galx-shards.json) with AAD binding.
 *    - 2 MB maximum payload guardrail (HTTP 413) & 10s Slowloris read timeout.
 * 2. Multi-Tenant Token-Bucket Rate Governor:
 *    - Per-tenant / per-key continuous leaky bucket with burst absorption and Retry-After headers.
 * 3. BroccoliDB Zenith-Tier Storage & Crash-Resilient Checkpointing:
 *    - relay_jobs: Sub-microsecond secondary indexes on status, model, shardId, and sorted createdAtMs.
 *    - relay_tokens: Sub-microsecond indexed lookups for Last-Event-ID token replay with native TTL auto-eviction.
 *    - relay_idempotency: Atomic Idempotent Stream Attachment via SHA-256 promptHash collapsing.
 *    - relay_shards: SWRR quota tracking & sliding 3-hour window meter.
 *    - Atomic file checkpointing (.broccolidb/relay-snapshot.json.tmp -> rename) for zero-corruption state recovery.
 * 4. Circuit Breakers & Outlier Detection:
 *    - 3-strike shard isolation on 5xx/429/TLS failures with 60s cooldown and AWS full-jitter backoff.
 * 5. Two-Tier Disconnect Protocol:
 *    - 15s Reconnect Grace Window for dirty drops vs instant <5ms wire abort for clean cancellations (Figma / Liveblocks).
 * 6. Dual-Heartbeat & Dead-Peer Detection:
 *    - Discord-style full-jitter WS pings with 5s pong deadline; instant TCP RST termination (ws.terminate()).
 *    - Periodic SSE comment heartbeats (: ping\n\n) to permanently defeat Cloudflare 100s idle timeouts.
 * 7. 7-Layer WebSocket Timeout Hierarchy (Connect, Model-Adaptive TTFT, EWMA ITL Gap, Intra-Chunk, Grace, Proxy Keepalive, Wall-Time).
 * 8. Downstream Backpressure Flow Control with High-Water Mark Bounded RingBuffer (Slack Flannel pattern).
 * 9. Graceful Drain on SIGTERM/SIGINT with 30s in-flight completion window.
 * 10. Authority Boundary:
 *    - JobQueue governs only bounded relay-delivery lifecycle; it is not authoritative agent-execution state.
 *    - Governed executions arrive as supervisor-authorized intents; WS/SSE remain projections and observations.
 */

import * as http from 'node:http';
import { imagePool, stagedPoolRequest, type RelayImagePool } from '../pools/pool-image-policy.js';
import { sitesContractRequest, sitesContractReply } from './sites-contract.js';
import type { Socket } from 'node:net';
import * as url from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { readJsonBody, validateModelRequest, RequestError, RetryBudget } from './request-policy.js';
import { AdmissionReceipts } from './admission-receipts.js';
import { completionUsage, completionFrame, type CompletionUsage } from './completion-usage.js';
import { functionInput, functionToolContract, completedFunctionCalls, type FunctionCall } from './function-tools.js';
import { DurableReceipts } from './durable-receipts.js';
import { upstreamDiagnostic, type UpstreamDiagnostic } from './upstream-diagnostic.js';
import { OutputBudget } from './output-budget.js';
import { RelayTelemetry } from './telemetry.js';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { classifyUpstreamError, cooldownDeadline, parseProviderLimits, retryDeadline, type ProviderLimit } from './quota-policy.js';
import { CODEX_IMAGE_ALIAS, IMAGE_TOOL_EVIDENCE_TTL_MS, imageExecution } from './image-compatibility.js';
import { generateCodexToolImage } from './codex-image-tool.js';
import { CapabilityRegistry, classifyCapabilityFailure } from './capability-registry.js';
import { CapabilityDiscoveryError, discoverOpenAIModels, type DiscoveryShard } from './capability-discovery.js';
import { registryConfig, readShardRegistry, decryptRegistryShard } from './shard-registry.js';
import { BroccoliDbTable } from '../storage/memory-table.js';
import { requestWorkload } from '../pools/pool-protocol.js';
import type { ExecutionPolicy, ExecutionGrant } from '../pools/pool-execution.js';
import {
  PRIVATE_RELAY_FAILURE_HEADER,
  classifyImageRelayFailure,
  encodePrivateRelayFailure,
  fleetRelayFailure,
} from './private-failure.js';

/** Add a fixed source/code label before capability classification. The
 * provider response itself is never retained or forwarded. */
function imageFailureFrame(error: any): any {
  if (!error?.upstream) return error;
  return { ...error.upstream, code: error.code, source: 'codex_image_tool' };
}

/**
 * Only a target-local rejection that proves useful image work was never
 * accepted may move this request to another shard. A timeout, socket close,
 * malformed result or generic provider error remains terminal because the
 * image mutation may already have started.
 */
function isConfirmedPreGenerationImageFailure(error: any, failure: ReturnType<typeof classifyUpstreamError>): boolean {
  const frame = imageFailureFrame(error);
  const status = Number(frame?.status ?? frame?.status_code ?? frame?.response?.status);
  const code = String(error?.code ?? frame?.error?.code ?? frame?.response?.error?.code ?? frame?.code ?? '').toLowerCase();
  const executionState = String(frame?.execution_state ?? frame?.response?.execution_state ?? error?.executionState ?? '').toLowerCase();
  const quotaCode = /quota|rate[ _-]?limit|usage_limit|too many requests|capacity/.test(code);
  const explicitRejection = executionState === 'not_accepted' || error?.preGeneration === true || frame?.preGeneration === true;
  const responseRejectedBeforeGeneration = frame?.type === 'response.failed' && quotaCode;
  const httpRejection = [401, 403, 404, 429].includes(status);
  return Boolean(
    (failure.quota && (status === 429 || responseRejectedBeforeGeneration || explicitRejection))
    || (failure.unauthorized && (httpRejection || explicitRejection))
  );
}

// ============================================================================
// CONFIGURATION & TIMEOUT TAXONOMY (Layer 0 through Layer 6)
// ============================================================================

export interface RelayConfig {
  executionPolicy?: ExecutionPolicy;
  assignedShardId?: string;
  /** Dormant pool-image packaging. No environment switch can activate this mode. */
  stagedPool?: RelayImagePool;
  relayId?: string;
  generation?: string;
  assignedShard?: DiscoveryShard;
  /** Test harness compatibility only; forbidden in production. */
  testOnlyMultiShard?: boolean;
  capabilityDiscovery?: (shard: DiscoveryShard, signal: AbortSignal) => Promise<string[]>;
  capabilityRefreshMs: number;
  capabilityTtlMs: number;
  codexImageToolAlias: boolean;
  port: number;
  maxConcurrentRequests: number;
  maxRssBytes: number;
  host: string;
  wsEndpoint: string;
  shardsJsonPath?: string;
  stateSnapshotPath: string;
  masterSecret?: string;
  shardConcurrency: number;
  discoverHostCredentials: boolean;
  registryEnabled: boolean;
  apiKeys?: string[];
  adminApiKeys?: string[];
  allowedOrigins?: string[];
  maxPayloadBytes: number;
  maxImagePayloadBytes: number;
  httpBodyTimeoutMs: number;
  // Multi-Tenant Rate Governance
  tenantRateLimitPerSec: number;
  tenantBurstCapacity: number;
  // 7-Layer Timeout Hierarchy & Anti-Fragility
  wsConnectTimeoutMs: number;          // Layer 0: TCP + TLS + Upgrade handshake budget (15s)
  wsTtftTimeoutMs: number;             // Layer 1: Time-To-First-Token base ceiling (60s)
  deepReasoningTtftMultiplier: number; // Layer 1: Multiplier for high-effort reasoning (2.0 = 120s)
  reasoningActivityExtensionMs: number;// Layer 1: Extension on receiving thinking progress (15s)
  itlGapThresholdMs: number;           // Layer 2: Inter-token latency stall trigger (8s)
  itlConsecutiveLimit: number;         // Layer 2: Hard abort after N consecutive ITL gaps (3)
  wsIntraChunkTimeoutMs: number;       // Layer 3: Silence between chunks (45s) - RESETS ON EVERY CHUNK
  clientDisconnectGraceMs: number;     // Layer 4: Wi-Fi glitch / cellular handoff grace window (15s)
  sseKeepaliveIntervalMs: number;      // Layer 5: SSE comment heartbeat interval (: ping\n\n) (15s)
  wsDeadPeerPingIntervalMs: number;    // Layer 5: Outbound WS ping interval with jitter (20s)
  wsDeadPeerPongTimeoutMs: number;     // Layer 5: WS pong ACK timeout before eviction (5s)
  jobMaxWallTimeMs: number;            // Layer 6: Absolute safety wall-clock cap (300s / 5 min)
  // Anti-Fragile Failover & Recovery
  maxUpstreamRetries: number;          // In-flight shard failovers before failing job (3)
  /** Enable only after this upstream has qualified max_output_tokens support. */
  forwardOutputTokenLimit?: boolean;
  /** In-process operator observer only. Never accepts or returns raw error data. */
  onUpstreamDiagnostic?: (diagnostic: UpstreamDiagnostic, context: { jobId: string }) => void;
  retryBaseDelayMs: number;            // Base backoff delay for retries (500ms)
  retryMaxDelayMs: number;             // Backoff ceiling for full jitter (5000ms)
  deDuplicationOverlapWindowChars: number; // Suffix window length for overlap reconciliation (128 chars)
  // Memory & Buffer Limits
  jobTokenRetentionMs: number;         // Post-completion buffer retention (10 min)
  maxBufferedTokensPerJob: number;     // Ring-buffer high-water mark
  busMaxListenersPerJob: number;       // Maximum SSE subscribers admitted per job
  maxPendingFramesPerSubscriber: number; // Per-subscriber outbound queue cap
  subscriberDrainTimeoutMs: number;    // Evict a subscriber that never drains
  drainTimeoutMs: number;              // Graceful shutdown drain deadline (30s)
  idempotencyTtlMs: number;            // Prompt deduplication TTL (120s)
  snapshotIntervalMs: number;          // Periodic disk checkpoint interval (60s)
  // Dynamic Sliding Window Quota Governance
  quotaWindowMaxCalls: number;         // Optional operator limit; 0 means no local call cap
  quotaWindowDurationMs: number;       // Duration of rolling window (default: 3h / 10800000ms)
}

/** Image providers are single-flight per assigned shard; text keeps pool capacity. */
export const IMAGE_SHARD_CONCURRENCY = 1;

function assignedShardFromEnvironment(): DiscoveryShard | undefined {
  if (!process.env.RELAY_ASSIGNED_SHARD) return;
  try { return JSON.parse(process.env.RELAY_ASSIGNED_SHARD); }
  catch { throw new Error('Invalid assigned shard configuration'); }
}

const DEFAULT_CONFIG: RelayConfig = {
  assignedShardId: process.env.RELAY_SHARD_ID,
  relayId: process.env.RELAY_ID,
  generation: process.env.RELAY_GENERATION,
  assignedShard: assignedShardFromEnvironment(),
  capabilityRefreshMs: Number(process.env.CAPABILITY_REFRESH_INTERVAL_MS || 60000),
  capabilityTtlMs: Number(process.env.CAPABILITY_TTL_MS || 120000),
  codexImageToolAlias: process.env.RELAY_CODEX_IMAGE_TOOL_ALIAS === 'true',
  forwardOutputTokenLimit: process.env.RELAY_SITES_OUTPUT_LIMIT_FORWARDING === 'true',
  port: parseInt(process.env.PORT || '3001', 10),
  maxConcurrentRequests: Number(process.env.RELAY_MAX_CONCURRENT_REQUESTS || 64),
  maxRssBytes: Number(process.env.RELAY_MAX_RSS_MB || 384) * 1024 * 1024,
  host: process.env.HOST || '127.0.0.1',
  wsEndpoint: process.env.CODEX_WS_ENDPOINT || 'wss://chatgpt.com/backend-api/codex/responses',
  shardsJsonPath: process.env.GALX_SHARDS_JSON_PATH || path.join(process.cwd(), '.galx-shards.json'),
  stateSnapshotPath: process.env.RELAY_STATE_SNAPSHOT_PATH || path.join(process.cwd(), '.broccolidb', 'relay-snapshot.json'),
  masterSecret: process.env.GALX_VAULT_MASTER_SECRET || process.env.GALX_VAULT_KEY,
  apiKeys: process.env.RELAY_API_KEYS ? process.env.RELAY_API_KEYS.split(',').map((k) => k.trim()) : undefined,
  adminApiKeys: process.env.RELAY_ADMIN_API_KEYS ? process.env.RELAY_ADMIN_API_KEYS.split(',').map(k => k.trim()) : undefined,
  allowedOrigins: process.env.RELAY_ALLOWED_ORIGINS?.split(',').map(origin => origin.trim()).filter(Boolean),
  shardConcurrency: Number(process.env.RELAY_SHARD_CONCURRENCY || 4),
  discoverHostCredentials: process.env.RELAY_DISCOVER_HOST_CREDENTIALS === 'true',
  registryEnabled: Boolean(registryConfig().databaseUrl || registryConfig().url || registryConfig().key),
  maxPayloadBytes: parseInt(process.env.MAX_PAYLOAD_BYTES || '2097152', 10), // 2 MB
  maxImagePayloadBytes: parseInt(process.env.MAX_IMAGE_PAYLOAD_BYTES || '33554432', 10), // bounded base64 image response
  httpBodyTimeoutMs: parseInt(process.env.HTTP_BODY_TIMEOUT_MS || '10000', 10), // 10s
  tenantRateLimitPerSec: parseFloat(process.env.TENANT_RATE_LIMIT_PER_SEC || '50.0'),
  tenantBurstCapacity: parseInt(process.env.TENANT_BURST_CAPACITY || '100', 10),
  wsConnectTimeoutMs: parseInt(process.env.WS_CONNECT_TIMEOUT_MS || '15000', 10),
  wsTtftTimeoutMs: parseInt(process.env.WS_TTFT_TIMEOUT_MS || '60000', 10),
  deepReasoningTtftMultiplier: parseFloat(process.env.DEEP_REASONING_TTFT_MULTIPLIER || '2.0'),
  reasoningActivityExtensionMs: parseInt(process.env.REASONING_ACTIVITY_EXTENSION_MS || '15000', 10),
  itlGapThresholdMs: parseInt(process.env.ITL_GAP_THRESHOLD_MS || '8000', 10),
  itlConsecutiveLimit: parseInt(process.env.ITL_CONSECUTIVE_LIMIT || '3', 10),
  wsIntraChunkTimeoutMs: parseInt(process.env.WS_INTRA_CHUNK_TIMEOUT_MS || '45000', 10),
  clientDisconnectGraceMs: parseInt(process.env.CLIENT_DISCONNECT_GRACE_MS || '15000', 10),
  sseKeepaliveIntervalMs: parseInt(process.env.SSE_KEEPALIVE_INTERVAL_MS || '15000', 10),
  wsDeadPeerPingIntervalMs: parseInt(process.env.WS_DEAD_PEER_PING_INTERVAL_MS || '20000', 10),
  wsDeadPeerPongTimeoutMs: parseInt(process.env.WS_DEAD_PEER_PONG_TIMEOUT_MS || '5000', 10),
  jobMaxWallTimeMs: parseInt(process.env.JOB_MAX_WALL_TIME_MS || '300000', 10),
  maxUpstreamRetries: parseInt(process.env.MAX_UPSTREAM_RETRIES || '3', 10),
  retryBaseDelayMs: parseInt(process.env.RETRY_BASE_DELAY_MS || '500', 10),
  retryMaxDelayMs: parseInt(process.env.RETRY_MAX_DELAY_MS || '5000', 10),
  deDuplicationOverlapWindowChars: parseInt(process.env.DEDUPLICATION_OVERLAP_WINDOW_CHARS || '128', 10),
  jobTokenRetentionMs: parseInt(process.env.JOB_TOKEN_RETENTION_MS || '600000', 10),
  maxBufferedTokensPerJob: parseInt(process.env.MAX_BUFFERED_TOKENS_PER_JOB || '10000', 10),
  busMaxListenersPerJob: parseInt(process.env.BUS_MAX_LISTENERS_PER_JOB || '50', 10),
  maxPendingFramesPerSubscriber: parseInt(process.env.MAX_PENDING_FRAMES_PER_SUBSCRIBER || '256', 10),
  subscriberDrainTimeoutMs: parseInt(process.env.SUBSCRIBER_DRAIN_TIMEOUT_MS || '5000', 10),
  drainTimeoutMs: parseInt(process.env.DRAIN_TIMEOUT_MS || '30000', 10),
  idempotencyTtlMs: parseInt(process.env.IDEMPOTENCY_TTL_MS || '120000', 10),
  snapshotIntervalMs: parseInt(process.env.SNAPSHOT_INTERVAL_MS || '60000', 10),
  quotaWindowMaxCalls: parseInt(process.env.RELAY_QUOTA_WINDOW_MAX || '0', 10),
  quotaWindowDurationMs: parseInt(process.env.RELAY_QUOTA_WINDOW_MS || String(3 * 60 * 60 * 1000), 10),
};

// ============================================================================
// BROCCOLIDB DATA CONTRACTS & SCHEMAS
// ============================================================================

export interface JobRecord extends Record<string, unknown> {
  id: string;
  model: string;
  prompt: string;
  promptHash: string;
  traceId?: string;
  tenantId: string;
  status: 'queued' | 'running' | 'streaming' | 'completed' | 'failed' | 'cancelled';
  createdAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
  shardId?: string;
  seqCounter: number;
  isDetached: boolean;
  error?: string;
  providerFailureObserved?: boolean;
  estimatedTokens: number;
  maxOutputTokens?: number;
  usage?: CompletionUsage;
  durableReceipt?: boolean;
  messagesJson: string;
  functionContract?: ReturnType<typeof functionToolContract>;
  outputToolCalls?: FunctionCall[];
  reasoningEffort?: string;
  retryCount?: number;
  failoverCount?: number;
  lastShardId?: string;
}

export interface JobTokenRecord extends Record<string, unknown> {
  id: string; // `${jobId}_${seqNo}`
  jobId: string;
  seqNo: number;
  text: string;
  isFinal: boolean;
  timestampMs: number;
}

export interface IdempotencyRecord extends Record<string, unknown> {
  id: string; // promptHash
  jobId: string;
  createdAtMs: number;
}

export type QuotaMode = 'conservative' | 'balanced' | 'turbo' | 'adaptive';

export interface QuotaProfileConfig {
  mode: QuotaMode;
  maxCalls: number;
  windowDurationMs: number;
  dripRefillSec: number;
  elasticBurstAllowance: number;
  adaptiveBackoffOn429: boolean;
}

export const QUOTA_PRESETS: Record<QuotaMode, QuotaProfileConfig> = {
  conservative: {
    mode: 'conservative',
    maxCalls: 40,
    windowDurationMs: 3 * 3600 * 1000,
    dripRefillSec: 270, // 1 token every 4.5m
    elasticBurstAllowance: 5,
    adaptiveBackoffOn429: true,
  },
  balanced: {
    mode: 'balanced',
    maxCalls: 100,
    windowDurationMs: 3 * 3600 * 1000,
    dripRefillSec: 108, // 1 token every 1.8m
    elasticBurstAllowance: 20,
    adaptiveBackoffOn429: true,
  },
  turbo: {
    mode: 'turbo',
    maxCalls: 250,
    windowDurationMs: 3 * 3600 * 1000,
    dripRefillSec: 43.2, // 1 token every 43.2s
    elasticBurstAllowance: 50,
    adaptiveBackoffOn429: true,
  },
  adaptive: {
    mode: 'adaptive',
    maxCalls: 0,
    windowDurationMs: 3 * 3600 * 1000,
    dripRefillSec: 0,
    elasticBurstAllowance: 0,
    adaptiveBackoffOn429: true,
  },
};

export interface ShardRecord extends Record<string, unknown> {
  id: string; // shardId
  accountId: string;
  accessToken: string;
  status: 'active' | 'exhausted' | 'cooldown' | 'disabled';
  consecutiveFailures: number;
  lastUsedAtMs: number;
  inFlight: number;
  /** Transient image-only occupancy; reset on process recovery. */
  imageInFlight?: number;
  slidingWindowTimestamps: number[];
  availableDripTokens?: number;
  lastDripRefillMs?: number;
  cooldownUntilMs?: number;
  quotaFailures?: number;
  lastQuotaFailureJobId?: string;
  /** Image-only provider eligibility; never disables independent text work. */
  imageConsecutiveFailures?: number;
  imageQuotaFailures?: number;
  imageCooldownUntilMs?: number;
  lastImageQuotaFailureJobId?: string;
  imageProbeInFlight?: boolean;
  probeInFlight?: boolean;
  providerLimits?: ProviderLimit[];
  source?: string;
  expiresAtMs?: number;
  credentialFingerprint?: string;
}

interface RuntimeShardOwnership {
  inFlight: number;
  imageInFlight: number;
}

interface TransientJobSession {
  abortController: AbortController;
  outputBudget?: OutputBudget;
  quotaFailureObserved?: boolean;
  receiptText?: string;
  graceTimer?: NodeJS.Timeout;
  upstreamWs?: any;
  connectTimer?: NodeJS.Timeout;
  ttftTimer?: NodeJS.Timeout;
  retryTimer?: NodeJS.Timeout;
  intraChunkTimer?: NodeJS.Timeout;
  wallTimer?: NodeJS.Timeout;
  wsPingTimer?: NodeJS.Timeout;
  heartbeatAckTimeoutTimer?: NodeJS.Timeout;
  downstreamFailoverKeepaliveTimer?: NodeJS.Timeout;
  lastChunkAtMs: number;
  ewmaItlMs: number;
  consecutiveItlStalls: number;
  retryCount: number;
  retryAtMs?: number;
  lastSeenAliveMs: number;
  activeTtftDeadlineMs: number;
  currentShardId?: string;
  attemptedShardIds: Set<string>;
  activeAttemptId: number;
}

interface TransportAttempt {
  id: number;
  shardId: string;
  hasReceivedFirstToken: boolean;
  heartbeatPending: boolean;
  completionObserved: boolean;
  isFirstChunkAfterFailover: boolean;
  priorFailoverSuffix?: string;
}

type JobBusEvent =
  | { type: 'job:transport_token'; jobId: string; attemptId: number; shardId: string; text: string; timestampMs: number }
  | { type: 'job:transport_completed'; jobId: string; attemptId: number; shardId: string; response?: unknown }
  | { type: 'job:token'; jobId: string; token: JobTokenRecord }
  | { type: 'job:reasoning'; jobId: string; text: string }
  | { type: 'job:keepalive'; jobId: string; text: string }
  | { type: 'job:transport_drop'; jobId: string; attemptId: number; shardId: string; reason: string; isQuotaError?: boolean; retryAtMs?: number; unauthorized?: boolean; retryable?: boolean; providerFailureObserved?: boolean }
  | { type: 'job:done'; jobId: string }
  | { type: 'job:error'; jobId: string; reason: string }
  | { type: 'job:cancelled'; jobId: string; reason?: string }
  | { type: 'relay:drained' };

type JobBusEventOf<T extends JobBusEvent['type']> = Extract<JobBusEvent, { type: T }>;

interface BusSubscriber {
  res: http.ServerResponse;
  tail: Promise<void>;
  pendingFrames: number;
  closed: boolean;
}

/**
 * Pub/sub plane. Public publication always crosses a microtask boundary.
 * Tokens are committed before fan-out and every SSE subscriber owns an
 * independent ordered write chain.
 */
class JobEventBus extends EventEmitter {
  private readonly subscribers = new Map<string, Set<BusSubscriber>>();
  private pendingDispatches = 0;
  private pendingWrites = 0;
  private readonly idleWaiters = new Set<() => void>();
  private readonly jobsTable: BroccoliDbTable<JobRecord>;
  private readonly tokensTable: BroccoliDbTable<JobTokenRecord>;
  private readonly config: RelayConfig;
  private readonly countEvent: () => void;
  private readonly countSlowDrain: () => void;

  constructor(
    jobsTable: BroccoliDbTable<JobRecord>,
    tokensTable: BroccoliDbTable<JobTokenRecord>,
    config: RelayConfig,
    countEvent: () => void,
    countSlowDrain: () => void,
  ) {
    super();
    for (const [name, value] of Object.entries({
      busMaxListenersPerJob: config.busMaxListenersPerJob,
      maxPendingFramesPerSubscriber: config.maxPendingFramesPerSubscriber,
      subscriberDrainTimeoutMs: config.subscriberDrainTimeoutMs,
      maxBufferedTokensPerJob: config.maxBufferedTokensPerJob,
      jobTokenRetentionMs: config.jobTokenRetentionMs,
    })) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer`);
      }
    }
    this.jobsTable = jobsTable;
    this.tokensTable = tokensTable;
    this.config = config;
    this.countEvent = countEvent;
    this.countSlowDrain = countSlowDrain;
    this.setMaxListeners(config.busMaxListenersPerJob);
  }

  public onEvent<T extends JobBusEvent['type']>(
    type: T,
    listener: (event: JobBusEventOf<T>) => void,
  ): this {
    return super.on(type, listener);
  }

  public publish(event: JobBusEvent): void {
    this.pendingDispatches++;
    queueMicrotask(() => {
      try {
        this.countEvent();
        this.dispatch(event);
        super.emit(event.type, event);
      } finally {
        this.pendingDispatches--;
        this.resolveIdleIfNeeded();
      }
    });
  }

  public subscribe(jobId: string, res: http.ServerResponse): () => void {
    const jobSubscribers = this.subscribers.get(jobId) ?? new Set<BusSubscriber>();
    if (jobSubscribers.size >= this.config.busMaxListenersPerJob) {
      throw new Error('job_subscriber_limit_exceeded');
    }

    const subscriber: BusSubscriber = {
      res,
      tail: Promise.resolve(),
      pendingFrames: 0,
      closed: false,
    };
    jobSubscribers.add(subscriber);
    this.subscribers.set(jobId, jobSubscribers);

    const unsubscribe = () => this.removeSubscriber(jobId, subscriber, false);
    res.once('close', unsubscribe);
    res.once('error', unsubscribe);
    return unsubscribe;
  }

  public replay(jobId: string, res: http.ServerResponse, afterSeqNo: number, onReplayed: () => void): void {
    const subscriber = [...(this.subscribers.get(jobId) ?? [])].find((entry) => entry.res === res);
    if (!subscriber) return;
    const tokens = this.tokensTable.query({
      where: { jobId },
      sortBy: 'seqNo',
      sortOrder: 'asc',
    });
    for (const token of tokens) {
      if (token.seqNo <= afterSeqNo) continue;
      this.enqueue(jobId, subscriber, this.formatToken(jobId, token), false);
      onReplayed();
    }
  }

  public subscriberCount(jobId: string): number {
    return this.subscribers.get(jobId)?.size ?? 0;
  }

  public sendToSubscriber(jobId: string, res: http.ServerResponse, frame: string, closeAfter = false): void {
    const subscriber = [...(this.subscribers.get(jobId) ?? [])].find((entry) => entry.res === res);
    if (subscriber) this.enqueue(jobId, subscriber, frame, closeAfter);
  }

  public whenIdle(): Promise<void> {
    if (this.pendingDispatches === 0 && this.pendingWrites === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private dispatch(event: JobBusEvent): void {
    if (event.type === 'job:token') {
      this.tokensTable.put(event.token.id, event.token, { ttlMs: this.config.jobTokenRetentionMs });
      if (event.token.seqNo > this.config.maxBufferedTokensPerJob) {
        this.tokensTable.delete(`${event.jobId}_${event.token.seqNo - this.config.maxBufferedTokensPerJob}`);
      }
      this.fanOut(event.jobId, this.formatToken(event.jobId, event.token));
      return;
    }
    if (event.type === 'job:reasoning') {
      const job = this.jobsTable.get(event.jobId);
      if (!job) return;
      const payload = JSON.stringify({
        id: job.id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: job.model,
        choices: [{ index: 0, delta: { reasoning_content: event.text }, finish_reason: null }],
      });
      this.fanOut(event.jobId, `data: ${payload}\n\n`);
      return;
    }
    if (event.type === 'job:keepalive') {
      this.fanOut(event.jobId, event.text);
      return;
    }
    if (event.type === 'job:done') {
      const job = this.jobsTable.get(event.jobId);
      this.fanOut(event.jobId, (job ? completionFrame(job) : '') + 'data: [DONE]\n\n', true);
      return;
    }
    if (event.type === 'job:error') {
      this.fanOut(event.jobId, `event: error\ndata: ${JSON.stringify({ error: event.reason,
        execution_state: this.jobsTable.get(event.jobId)?.continuationAllowed === true ? 'failed' : 'unknown' })}\n\n`, true);
      return;
    }
    if (event.type === 'job:cancelled') {
      this.fanOut(
        event.jobId,
        `event: cancelled\ndata: ${JSON.stringify({ status: 'cancelled', reason: event.reason })}\n\n`,
        true,
      );
    }
  }

  private formatToken(jobId: string, token: JobTokenRecord): string {
    const job = this.jobsTable.get(jobId);
    const payload = JSON.stringify({
      id: jobId,
      object: 'chat.completion.chunk',
      created: Math.floor(token.timestampMs / 1000),
      model: job?.model ?? 'unknown',
      choices: [{
        index: 0,
        delta: token.text ? { content: token.text } : {},
        finish_reason: token.isFinal ? 'stop' : null,
      }],
      seqNo: token.seqNo,
    });
    return `id: ${token.seqNo}\ndata: ${payload}\n\n`;
  }

  private fanOut(jobId: string, frame: string, closeAfter = false): void {
    for (const subscriber of [...(this.subscribers.get(jobId) ?? [])]) {
      this.enqueue(jobId, subscriber, frame, closeAfter);
    }
  }

  private enqueue(jobId: string, subscriber: BusSubscriber, frame: string, closeAfter: boolean): void {
    if (subscriber.closed || subscriber.res.writableEnded) {
      this.removeSubscriber(jobId, subscriber, false);
      return;
    }
    if (subscriber.pendingFrames >= this.config.maxPendingFramesPerSubscriber) {
      this.removeSubscriber(jobId, subscriber, true);
      return;
    }

    subscriber.pendingFrames++;
    this.pendingWrites++;
    subscriber.tail = subscriber.tail
      .then(async () => {
        if (subscriber.closed || subscriber.res.writableEnded) return;
        if (!subscriber.res.write(frame)) {
          this.countSlowDrain();
          await this.waitForDrainOrClose(jobId, subscriber);
        }
        if (closeAfter && !subscriber.closed && !subscriber.res.writableEnded) {
          subscriber.res.end();
          this.removeSubscriber(jobId, subscriber, false);
        }
      })
      .catch(() => this.removeSubscriber(jobId, subscriber, true))
      .finally(() => {
        subscriber.pendingFrames--;
        this.pendingWrites--;
        this.resolveIdleIfNeeded();
      });
  }

  private waitForDrainOrClose(jobId: string, subscriber: BusSubscriber): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        subscriber.res.off('drain', finish);
        subscriber.res.off('close', finish);
        subscriber.res.off('error', finish);
        resolve();
      };
      timer = setTimeout(() => {
        this.removeSubscriber(jobId, subscriber, true);
        finish();
      }, this.config.subscriberDrainTimeoutMs);
      subscriber.res.once('drain', finish);
      subscriber.res.once('close', finish);
      subscriber.res.once('error', finish);
    });
  }

  private removeSubscriber(jobId: string, subscriber: BusSubscriber, close: boolean): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    const jobSubscribers = this.subscribers.get(jobId);
    jobSubscribers?.delete(subscriber);
    if (jobSubscribers?.size === 0) this.subscribers.delete(jobId);
    if (close && !subscriber.res.writableEnded) subscriber.res.end();
  }

  private resolveIdleIfNeeded(): void {
    if (this.pendingDispatches !== 0 || this.pendingWrites !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

/**
 * Relay queue-plane lifecycle coordinator. This owns only the operational
 * lifecycle of a bounded relay delivery job; authoritative evolving agent
 * execution state belongs to the upstream ExecutionSupervisor and ledger.
 */
class JobQueue {
  private readonly jobsTable: BroccoliDbTable<JobRecord>;
  private readonly bus: JobEventBus;

  constructor(
    jobsTable: BroccoliDbTable<JobRecord>,
    bus: JobEventBus,
    private readonly retentionMs = 600000,
  ) {
    this.jobsTable = jobsTable;
    this.bus = bus;
  }

  public enqueue(job: JobRecord): JobRecord {
    if (this.jobsTable.get(job.id)) throw new Error(`job_already_exists_${job.id}`);
    return this.jobsTable.put(job.id, { ...job, status: 'queued' });
  }

  public restore(job: JobRecord): JobRecord {
    return this.jobsTable.put(job.id, job, this.isTerminal(job.status) ? { ttlMs: this.retentionMs } : undefined);
  }

  public acquireForDispatch(jobId: string, shardId: string, retryCount: number): JobRecord | undefined {
    const job = this.jobsTable.get(jobId);
    if (!job || this.isTerminal(job.status)) return undefined;
    return this.jobsTable.put(jobId, {
      ...job,
      shardId,
      lastShardId: shardId,
      status: job.seqCounter > 0 ? 'streaming' : 'running',
      startedAtMs: job.startedAtMs || Date.now(),
      retryCount,
    });
  }

  public recordToken(jobId: string): { job: JobRecord; seqNo: number } | undefined {
    const job = this.jobsTable.get(jobId);
    if (!job || this.isTerminal(job.status)) return undefined;
    const seqNo = job.seqCounter + 1;
    const updated = this.jobsTable.put(jobId, { ...job, status: 'streaming', seqCounter: seqNo });
    return { job: updated, seqNo };
  }

  public updateForFailover(jobId: string, updates: Partial<JobRecord>): JobRecord | undefined {
    const job = this.jobsTable.get(jobId);
    if (!job || this.isTerminal(job.status)) return undefined;
    return this.jobsTable.put(jobId, { ...job, ...updates });
  }

  public setDetached(jobId: string, isDetached: boolean): JobRecord | undefined {
    const job = this.jobsTable.get(jobId);
    if (!job || this.isTerminal(job.status)) return undefined;
    return this.jobsTable.put(jobId, { ...job, isDetached });
  }

  public markComplete(jobId: string, response?: unknown): boolean {
    return this.transitionTerminal(jobId, 'completed', undefined, response);
  }

  public markFailed(jobId: string, reason: string): boolean {
    return this.transitionTerminal(jobId, 'failed', reason);
  }

  public markCancelled(jobId: string, reason?: string): boolean {
    return this.transitionTerminal(jobId, 'cancelled', reason);
  }

  public activeCount(): number {
    return this.jobsTable.getAll().filter(
      (job) => job.status === 'queued' || job.status === 'running' || job.status === 'streaming',
    ).length;
  }

  private transitionTerminal(
    jobId: string,
    status: Extract<JobRecord['status'], 'completed' | 'failed' | 'cancelled'>,
    reason?: string,
    response?: unknown,
  ): boolean {
    const job = this.jobsTable.get(jobId);
    if (!job || this.isTerminal(job.status)) return false;
    const activeBefore = this.activeCount();
    this.jobsTable.put(jobId, {
      ...job,
      status,
      error: reason,
      completedAtMs: Date.now(),
      usage: status === 'completed' ? completionUsage(response, job.retryCount ?? 0, job.failoverCount ?? 0) : undefined,
    }, { ttlMs: this.retentionMs });
    if (status === 'completed') this.bus.publish({ type: 'job:done', jobId });
    if (status === 'failed') this.bus.publish({ type: 'job:error', jobId, reason: reason ?? 'unknown_failure' });
    if (status === 'cancelled') this.bus.publish({ type: 'job:cancelled', jobId, reason });
    if (activeBefore > 0 && this.activeCount() === 0) this.bus.publish({ type: 'relay:drained' });
    return true;
  }

  private isTerminal(status: JobRecord['status']): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
  }
}

// ============================================================================
// STREAM SUFFIX-PREFIX OVERLAP RECONCILIATION (Figma / Liveblocks / CRDT Pattern)
// ============================================================================

export function reconcileOverlap(suffix: string, incoming: string, maxOverlapLen = 128): string {
  if (!suffix || !incoming) return incoming;

  // 1. Direct identical match: entire chunk was a duplicate echo from continuation prompt
  if (suffix.endsWith(incoming)) {
    return '';
  }

  const checkLen = Math.min(suffix.length, incoming.length, maxOverlapLen);

  // 2. Greedy character-level suffix-prefix overlap search
  for (let k = checkLen; k > 0; k--) {
    const incomingPrefix = incoming.slice(0, k);
    if (suffix.endsWith(incomingPrefix)) {
      return incoming.slice(k);
    }
  }

  // 3. Word-boundary fuzzy overlap search (handling trailing space variations)
  const suffixWords = suffix.trim().split(/\s+/);
  const incomingWords = incoming.trimStart().split(/\s+/);
  for (let w = Math.min(suffixWords.length, incomingWords.length, 6); w > 0; w--) {
    const sSub = suffixWords.slice(-w).join(' ');
    const iSub = incomingWords.slice(0, w).join(' ');
    if (sSub === iSub) {
      const matchIdx = incoming.indexOf(iSub);
      if (matchIdx !== -1) {
        return incoming.slice(matchIdx + iSub.length).replace(/^[\s]+/, ' ');
      }
    }
  }

  return incoming;
}

// ============================================================================
// CRYPTOGRAPHIC ENVELOPE DECRYPTION (AES-256-GCM + HKDF)
// ============================================================================

function decryptShardPayload(
  enc: { ciphertext: string; iv: string; tag: string; keyVersion?: string },
  masterSecret: string,
  tenantUid: string,
  shardId: string,
  provider = 'openai'
): Record<string, any> | null {
  try {
    const key = Buffer.from(
      crypto.hkdfSync(
        'sha256',
        Buffer.from(masterSecret, 'utf-8'),
        Buffer.from('galx-vault-salt-2026', 'utf-8'),
        Buffer.from(`galx-shard-isolation-${enc.keyVersion || 'v1'}`, 'utf-8'),
        32
      )
    );

    const iv = Buffer.from(enc.iv, 'hex');
    const tag = Buffer.from(enc.tag, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    const aad = Buffer.from(`${tenantUid}:${shardId}:${provider}`, 'utf-8');
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(enc.ciphertext, 'hex', 'utf-8');
    decrypted += decipher.final('utf-8');
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

// ============================================================================
// HARDENED RELAY SERVER POWERED BY BROCCOLIDB
// ============================================================================

export class NovaRelayServer extends EventEmitter {
  private durableReceipts?: DurableReceipts;
  private receiptStore(): DurableReceipts {
    return this.durableReceipts ??= new DurableReceipts(this.config.stateSnapshotPath + '.receipts');
  }
  private config: RelayConfig;
  private server: http.Server;
  private readonly telemetry = new RelayTelemetry();
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  private readonly retryBudget = new RetryBudget();
  private readonly imageReceipts = new AdmissionReceipts();
  private readonly imageControllers = new Set<AbortController>();
  private readonly principals = new WeakMap<http.IncomingMessage, string>();
  private readonly requestTraces = new WeakMap<http.IncomingMessage, string>();

  // BroccoliDB Zenith-Tier Tables
  private readonly jobsTable: BroccoliDbTable<JobRecord>;
  private readonly tokensTable: BroccoliDbTable<JobTokenRecord>;
  private readonly idempotencyTable: BroccoliDbTable<IdempotencyRecord>;
  private readonly shardsTable: BroccoliDbTable<ShardRecord>;
  private readonly jobBus: JobEventBus;
  private readonly jobQueue: JobQueue;

  // Multi-Tenant Rate Governor (Token Bucket)
  private readonly tenantBuckets = new Map<string, { tokens: number; lastRefillMs: number }>();

  // Dynamic Shard Quota & Continuous Drip Engine
  private currentQuotaProfile: QuotaProfileConfig = { ...QUOTA_PRESETS.adaptive };
  private shardCursor = 0;
  private readonly capabilities: CapabilityRegistry;
  private capabilityRefresh?: Promise<void>;
  private nextImageProbeAt = 0;
  private imageProbeFailures = 0;
  private imageCapabilityProbe?: Promise<unknown>;
  private capabilityTimer?: NodeJS.Timeout;
  private capabilityError?: string;
  private readonly capabilityControllers = new Set<AbortController>();
  private registryRefresh?: Promise<void>;
  private registryRefreshedAtMs = 0;
  private registryError: string | null = null;
  private registryCounts = { total: 0, skipped: 0 };
  private recoveredShardState = new Map<string, Partial<ShardRecord>>();
  /** Ephemeral ownership survives registry refreshes, never checkpoint recovery. */
  private readonly runtimeShardOwnership = new Map<string, RuntimeShardOwnership>();

  // Ephemeral In-Flight Sessions
  private readonly sessions = new Map<string, TransientJobSession>();
  private readonly executionGrants = new Map<string, ExecutionGrant>();
  private isDraining = false;
  private admittedRequests = 0;
  private stopping?: Promise<void>;
  private readonly sockets = new Set<Socket>();
  private snapshotIntervalTimer?: NodeJS.Timeout;

  // Prometheus Telemetry Counters
  private metrics = {
    totalJobsSubmitted: 0,
    totalJobsCompleted: 0,
    totalJobsCancelled: 0,
    totalJobsFailed: 0,
    totalAttachedDuplicates: 0,
    totalTokensEmitted: 0,
    totalTokensServedFromBuffer: 0,
    totalReconnections: 0,
    totalGracePeriodsEntered: 0,
    totalGraceReconnectionsWon: 0,
    totalZombieLeashAborts: 0,
    totalItlStallsDetected: 0,
    totalTtftDeadlocks: 0,
    totalRateLimitDrops: 0,
    totalAuthFailures: 0,
    totalUpstreamRetries: 0,
    totalMidStreamFailoversWon: 0,
    totalShardCooldownEjections: 0,
    totalDeadPeerRecoveries: 0,
    totalReasoningChunksReceived: 0,
    totalHeartbeatAckMisses: 0,
    totalOverlapReconciliationsWon: 0,
    totalDownstreamFailoverKeepalivesSent: 0,
    totalProactiveRateLimitCooldowns: 0,
    totalBusEventsEmitted: 0,
    totalSlowSubscriberDrains: 0,
    totalImageJobsSubmitted: 0,
    totalImageJobsCompleted: 0,
    totalImageJobsFailed: 0,
    startTimeMs: Date.now(),
  };

  constructor(config: Partial<RelayConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (this.config.stagedPool !== undefined) {
      imagePool(this.config.stagedPool);
      if (this.config.assignedShard || this.config.assignedShardId || this.config.registryEnabled || this.config.testOnlyMultiShard) {
        throw new Error('Staged pool images cannot receive account authority');
      }
      if (!this.config.apiKeys?.length || !this.config.adminApiKeys?.length
        || this.config.apiKeys.some(key => this.config.adminApiKeys!.includes(key))) {
        throw new Error('Staged pool images require separate inference and administrator keys');
      }
    }
    if (this.config.discoverHostCredentials) throw new Error('Host credential discovery is retired. Enroll manually in Relay Desktops.');
    if (this.config.testOnlyMultiShard && process.env.NODE_ENV === 'production') throw new Error('Production relays must own exactly one shard');
    if (this.config.assignedShard) {
      if (!this.config.assignedShardId || this.config.assignedShard.id !== this.config.assignedShardId
        || !this.config.assignedShard.accessToken || !this.config.assignedShard.accountId) throw new Error('Assigned shard identity mismatch');
      this.config.registryEnabled = false;
      this.config.discoverHostCredentials = false;
    }
    if (this.config.executionPolicy && (!this.config.assignedShard || this.config.stagedPool || this.config.testOnlyMultiShard || this.config.maxUpstreamRetries !== 0)) throw Error('Pool execution requires one assigned account and no account failover.');
    if (!Number.isSafeInteger(this.config.capabilityRefreshMs) || this.config.capabilityRefreshMs < 1000
      || this.config.capabilityRefreshMs > this.config.capabilityTtlMs) throw new Error('Invalid capability refresh interval');
    this.capabilities = new CapabilityRegistry(Date.now, this.config.capabilityTtlMs);
    this.config.generation ??= crypto.randomUUID();
    for (const name of ['apiKeys', 'adminApiKeys'] as const) {
      if (this.config[name]?.some(key => typeof key !== 'string' || !key.trim())) throw new TypeError(`${name} must contain nonempty keys`);
    }
    // Existing single-key installations retain admin access; additional keys are inference-only.
    this.config.adminApiKeys ??= this.config.apiKeys?.slice(0, 1);
    if (!['127.0.0.1', '::1', 'localhost'].includes(this.config.host) && !this.config.apiKeys?.length && !this.config.adminApiKeys?.length) {
      throw new TypeError('Non-loopback relay listeners require RELAY_API_KEYS or RELAY_ADMIN_API_KEYS');
    }
    for (const origin of this.config.allowedOrigins ?? []) {
      const parsed = new URL(origin);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new TypeError('allowedOrigins must contain exact HTTP(S) origins');
    }
    for (const name of ['maxConcurrentRequests', 'maxRssBytes', 'jobMaxWallTimeMs', 'httpBodyTimeoutMs', 'maxPayloadBytes', 'maxImagePayloadBytes'] as const) {
      if (!Number.isSafeInteger(this.config[name]) || this.config[name] <= 0) throw new TypeError(`${name} must be a positive safe integer`);
    }
    if (!Number.isSafeInteger(this.config.maxUpstreamRetries) || this.config.maxUpstreamRetries < 0 || this.config.maxUpstreamRetries > 32) {
      throw new TypeError('maxUpstreamRetries must be an integer between 0 and 32');
    }
    for (const name of ['retryBaseDelayMs', 'retryMaxDelayMs', 'wsConnectTimeoutMs', 'wsTtftTimeoutMs', 'wsIntraChunkTimeoutMs', 'jobMaxWallTimeMs'] as const) {
      if (!Number.isSafeInteger(this.config[name]) || this.config[name] < 1 || this.config[name] > 2147483647) {
        throw new TypeError(`${name} must be an integer between 1 and 2147483647 milliseconds`);
      }
    }
    if (this.config.retryBaseDelayMs > this.config.retryMaxDelayMs) throw new TypeError('retryBaseDelayMs must not exceed retryMaxDelayMs');
    if (!Number.isSafeInteger(this.config.drainTimeoutMs) || this.config.drainTimeoutMs <= 0) {
      throw new TypeError('drainTimeoutMs must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.config.shardConcurrency) || this.config.shardConcurrency < 1) throw new TypeError('shardConcurrency must be positive');
    if (!Number.isSafeInteger(this.config.quotaWindowMaxCalls) || this.config.quotaWindowMaxCalls < 0) throw new TypeError('quotaWindowMaxCalls must be nonnegative');
    if (!Number.isSafeInteger(this.config.quotaWindowDurationMs) || this.config.quotaWindowDurationMs <= 0) throw new TypeError('quotaWindowDurationMs must be positive');
    this.currentQuotaProfile = {
      ...QUOTA_PRESETS.adaptive,
      maxCalls: this.config.quotaWindowMaxCalls,
      windowDurationMs: this.config.quotaWindowDurationMs,
    };
    this.server = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify({ error: { code: 'internal_error', message: 'Relay request failed. Inspect its trace ID.' } }));
      });
    });
    this.server.keepAliveTimeout = 300000; // 5 minutes keepalive for deep reasoning
    this.server.headersTimeout = 305000;   // 5 min + 5s buffer
    this.server.requestTimeout = 0;        // Never timeout active reasoning sockets
    this.server.maxHeadersCount = 200;

    this.server.on('connection', socket => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });

    this.server.on('error', (err: any) => {
      console.error('[NOVA Relay] Server socket error:', err.message);
    });

    this.server.on('clientError', (err: any, socket) => {
      if (err.code === 'ECONNRESET' || !socket.writable) return;
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });

    // Initialize BroccoliDB Tables with Secondary & Sorted Indexes
    this.jobsTable = new BroccoliDbTable<JobRecord>('relay_jobs');
    this.jobsTable.createIndex('status');
    this.jobsTable.createIndex('model');
    this.jobsTable.createIndex('shardId');
    this.jobsTable.createSortedIndex('createdAtMs');

    this.tokensTable = new BroccoliDbTable<JobTokenRecord>('relay_tokens');
    this.tokensTable.createIndex('jobId');
    this.tokensTable.createSortedIndex('seqNo');

    this.idempotencyTable = new BroccoliDbTable<IdempotencyRecord>('relay_idempotency');

    this.shardsTable = new BroccoliDbTable<ShardRecord>('relay_shards');
    this.shardsTable.createIndex('status');
    this.shardsTable.createSortedIndex('inFlight');

    this.jobBus = new JobEventBus(
      this.jobsTable,
      this.tokensTable,
      this.config,
      () => { this.metrics.totalBusEventsEmitted++; },
      () => { this.metrics.totalSlowSubscriberDrains++; },
    );
    this.jobQueue = new JobQueue(this.jobsTable, this.jobBus, this.config.jobTokenRetentionMs);
    this.jobBus.onEvent('job:transport_token', (event) => this.handleTransportToken(event));
    this.jobBus.onEvent('job:transport_completed', (event) => this.handleTransportCompleted(event));
    for (const type of ['job:error', 'job:cancelled'] as const) this.jobBus.onEvent(type, event => {
      const job = this.jobsTable.get(event.jobId);
      if (job?.durableReceipt) try { this.receiptStore().stop(job.id, job.tenantId); } catch { /* Never manufacture a terminal receipt. */ }
    });
    this.jobBus.onEvent('job:transport_drop', (event) => this.handleTransportDrop(event));

    // Subscribe to BroccoliDB CDC Stream for Reactive Job Lifecycle Logging
    this.jobsTable.subscribe((change) => {
      if (change.after && ['completed', 'failed', 'cancelled'].includes(change.after.status)) {
        const grant = this.executionGrants.get(change.after.id);
        if (grant) {
          this.executionGrants.delete(change.after.id);
          // Job termination is not an upstream health verdict. In particular,
          // cancellation, deadlines, local errors and lost transport are neutral.
          const success = change.after.status === 'completed' ? true
            : change.after.status === 'failed' && change.after.providerFailureObserved === true ? false : null;
          void grant.complete(success,change.after.usage?.total_tokens).catch(()=>{});
        }
        this.telemetry.finish(change.after.id, change.after.status as 'completed' | 'failed' | 'cancelled', change.after.error);
        const session = this.sessions.get(change.after.id);
        if (session) {
          for (const [key, timer] of Object.entries(session)) if (key.endsWith('Timer')) clearTimeout(timer as NodeJS.Timeout);
          this.sessions.delete(change.after.id);
        }
      }
      if (change.operation === 'UPDATE' && change.after?.status === 'completed') {
        this.emit('job:completed', change.after);
      }
    });

    this.recoverStateSnapshot();
    this.loadShardFleet();
    this.startPeriodicSnapshot();
  }

  // --------------------------------------------------------------------------
  // ZERO-TRUST SECURITY: AUTHENTICATION & RATE GOVERNANCE
  // --------------------------------------------------------------------------

  private verifyAuthorization(req: http.IncomingMessage, admin = false): boolean {
    const keys = admin ? this.config.adminApiKeys ?? [] : [...(this.config.apiKeys ?? []), ...(this.config.adminApiKeys ?? [])];
    if (!this.config.apiKeys?.length && !this.config.adminApiKeys?.length) {
      return true; // Open access in dev/local mode
    }

    const authHeader = req.headers['authorization'];
    const apiKeyHeader = req.headers['x-galx-api-key'] as string;
    let providedToken = '';

    if (authHeader && authHeader.startsWith('Bearer ')) {
      providedToken = authHeader.slice(7).trim();
    } else if (apiKeyHeader) {
      providedToken = apiKeyHeader.trim();
    }

    if (!providedToken) {
      this.metrics.totalAuthFailures++;
      return false;
    }

    // Timing-Safe Constant-Time Verification against configured keys
    const providedBuffer = Buffer.from(providedToken, 'utf-8');
    for (const validKey of keys) {
      const validBuffer = Buffer.from(validKey, 'utf-8');
      if (providedBuffer.length === validBuffer.length && crypto.timingSafeEqual(providedBuffer, validBuffer)) {
        this.principals.set(req, crypto.createHash('sha256').update(validKey).digest('hex'));
        return true;
      }
    }

    this.metrics.totalAuthFailures++;
    return false;
  }

  private checkTenantRateLimit(tenantId: string): boolean {
    const now = Date.now();
    let bucket = this.tenantBuckets.get(tenantId);

    if (!bucket) {
      bucket = { tokens: this.config.tenantBurstCapacity, lastRefillMs: now };
      this.tenantBuckets.set(tenantId, bucket);
    } else {
      const elapsedSec = (now - bucket.lastRefillMs) / 1000;
      bucket.tokens = Math.min(
        this.config.tenantBurstCapacity,
        bucket.tokens + elapsedSec * this.config.tenantRateLimitPerSec
      );
      bucket.lastRefillMs = now;
    }

    if (bucket.tokens >= 1.0) {
      bucket.tokens -= 1.0;
      return true;
    }

    this.metrics.totalRateLimitDrops++;
    return false;
  }

  // --------------------------------------------------------------------------
  // SHARD FLEET MANAGEMENT (Governed by BroccoliDB + Vault Decryption)
  // --------------------------------------------------------------------------

  private runtimeOwnership(shard: ShardRecord): RuntimeShardOwnership {
    const owned = this.runtimeShardOwnership.get(shard.id);
    const inFlight = Math.max(0, Number.isSafeInteger(owned?.inFlight ?? shard.inFlight) ? Number(owned?.inFlight ?? shard.inFlight) : 0);
    const imageInFlight = Math.max(0, Number.isSafeInteger(owned?.imageInFlight ?? shard.imageInFlight) ? Number(owned?.imageInFlight ?? shard.imageInFlight) : 0);
    return { inFlight, imageInFlight: Math.min(inFlight, imageInFlight) };
  }

  private persistShard(shard: ShardRecord): void {
    const ownership = this.runtimeShardOwnership.get(shard.id);
    this.shardsTable.put(shard.id, ownership
      ? { ...shard, inFlight: ownership.inFlight, imageInFlight: ownership.imageInFlight }
      : shard);
  }

  private updateRuntimeOwnership(shard: ShardRecord, inFlight: number, imageInFlight: number): void {
    const next = { inFlight: Math.max(0, inFlight), imageInFlight: Math.min(Math.max(0, inFlight), Math.max(0, imageInFlight)) };
    if (next.inFlight || next.imageInFlight) this.runtimeShardOwnership.set(shard.id, next);
    else this.runtimeShardOwnership.delete(shard.id);
    this.persistShard({ ...shard, inFlight: next.inFlight, imageInFlight: next.imageInFlight });
  }

  private releaseRuntimeOwnership(shardId: string, imageWorkload: boolean): void {
    const current = this.runtimeShardOwnership.get(shardId);
    if (!current) return;
    const next = {
      inFlight: Math.max(0, current.inFlight - 1),
      imageInFlight: Math.min(Math.max(0, current.inFlight - 1), Math.max(0, current.imageInFlight - (imageWorkload ? 1 : 0))),
    };
    const shard = this.shardsTable.get(shardId);
    if (next.inFlight || next.imageInFlight) this.runtimeShardOwnership.set(shardId, next);
    else this.runtimeShardOwnership.delete(shardId);
    if (shard) this.persistShard({ ...shard, inFlight: next.inFlight, imageInFlight: next.imageInFlight });
  }

  private installFleet(items: Array<Partial<ShardRecord> & { accessToken: string; accountId: string }>): void {
    if (!this.config.testOnlyMultiShard && items.length > 1) throw new Error('One active shard requires one relay container');
    if (this.config.assignedShardId && items.some(s => s.id !== this.config.assignedShardId)) throw new Error('Relay cannot enroll another shard');
    const previous = this.shardsTable.getAll();
    const seen = new Set<string>();
    const next: ShardRecord[] = [];
    // Decode expiry only as an exclusion hint; upstream still authenticates tokens.
    items = items.map(item => {
      let tokenExpiry: number | undefined;
      try {
        const exp = JSON.parse(Buffer.from(item.accessToken.split('.')[1], 'base64url').toString()).exp;
        if (typeof exp === 'number' && Number.isFinite(exp)) tokenExpiry = exp * 1000;
      } catch {}
      const expiries = [item.expiresAtMs, tokenExpiry].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      return { ...item, expiresAtMs: expiries.length ? Math.min(...expiries) : undefined };
    });
    // Prefer the newest credential for each account over expired duplicate rows.
    for (const item of [...items].sort((a, b) => (b.expiresAtMs ?? 0) - (a.expiresAtMs ?? 0))) {
      // Account identity survives token rotation and copies in multiple sources.
      const identity = item.accountId.startsWith('acc_')
        ? crypto.createHash('sha256').update(item.accessToken).digest('hex') : item.accountId;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const id = item.id || `shard_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
      const old = previous.find(s => s.id === id || (s.accountId === item.accountId && !s.accountId.startsWith('acc_')) || s.accessToken === item.accessToken);
      const state = old ?? this.recoveredShardState.get(id);
      const ownership = this.runtimeShardOwnership.get(id) ?? {
        inFlight: old?.inFlight ?? 0,
        imageInFlight: old?.imageInFlight ?? 0,
      };
      if (ownership.inFlight || ownership.imageInFlight) this.runtimeShardOwnership.set(id, ownership);
      const credentialFingerprint = crypto.createHash('sha256').update(item.accessToken).digest('hex');
      const rotated = old ? old.accessToken !== item.accessToken
        : Boolean(state?.credentialFingerprint && state.credentialFingerprint !== credentialFingerprint);
      next.push({
        id: old?.id ?? id, accountId: item.accountId, accessToken: item.accessToken,
        source: item.source, expiresAtMs: item.expiresAtMs, credentialFingerprint,
        status: state?.status === 'disabled' && rotated ? 'active' : state?.status ?? item.status ?? 'active',
        consecutiveFailures: state?.consecutiveFailures ?? 0,
        quotaFailures: state?.quotaFailures ?? 0,
        imageConsecutiveFailures: state?.imageConsecutiveFailures ?? 0,
        imageQuotaFailures: state?.imageQuotaFailures ?? 0,
        lastUsedAtMs: state?.lastUsedAtMs ?? 0,
        inFlight: ownership.inFlight,
        probeInFlight: old?.probeInFlight ?? false,
        imageProbeInFlight: old?.imageProbeInFlight ?? false,
        cooldownUntilMs: Math.max(state?.cooldownUntilMs ?? 0, item.cooldownUntilMs ?? 0),
        imageCooldownUntilMs: state?.imageCooldownUntilMs ?? 0,
        lastImageQuotaFailureJobId: state?.lastImageQuotaFailureJobId,
        providerLimits: state?.providerLimits ?? [],
        slidingWindowTimestamps: state?.slidingWindowTimestamps ?? [],
        // This is process-local occupancy. Preserve it across a registry
        // refresh for the same live shard, but never restore it from a
        // checkpoint after restart (an old request cannot still own a slot).
        imageInFlight: ownership.imageInFlight,
      });
    }
    for (const old of previous) if (!next.some(s => s.id === old.id && s.credentialFingerprint === old.credentialFingerprint)) {
      this.capabilities.remove(old.id);
      const ownership = this.runtimeShardOwnership.get(old.id);
      if (!ownership?.inFlight && !ownership?.imageInFlight) this.runtimeShardOwnership.delete(old.id);
    }
    this.shardsTable.clear();
    for (const shard of next) {
      this.persistShard(shard);
      this.capabilities.register(shard.id, this.config.relayId || `relay-${shard.id}`, this.config.generation!, 'openai', this.config.shardConcurrency);
    }
  }

  private loadShardFleet(): void {
    if (this.config.assignedShard) { this.installFleet([{ ...this.config.assignedShard }]); return; }
    if (this.config.registryEnabled) return;
    if (!this.config.testOnlyMultiShard) { this.installFleet([]); return; }
    const items: Array<Partial<ShardRecord> & { accessToken: string; accountId: string }> = [];
    const add = (item: any, source: string) => {
      if (!item || item.permissionRetracted || ['revoked', 'disabled', 'expired'].includes(item.status)) return;
      if (item.provider && item.provider !== 'openai') return;
      let secret = item.tokens ?? item;
      const enc = item.encryptedPayload || item.encryptedSecrets;
      if (enc && this.config.masterSecret) secret = decryptShardPayload(enc, this.config.masterSecret, item.userId, item.id, item.provider) ?? {};
      const accessToken = secret.accessToken || secret.access_token || secret.token;
      if (typeof accessToken !== 'string' || !accessToken) return;
      let accountId = secret.accountId || secret.account_id || item.accountId || item.account_id;
      try { accountId ||= JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString())['https://api.openai.com/auth']?.chatgpt_account_id; } catch {}
      let expiresAtMs = Number(secret.expiresAtMs || item.expiresAtMs) || undefined;
      try { expiresAtMs ||= JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()).exp * 1000 || undefined; } catch {}
      items.push({ id: item.id, accessToken, accountId: accountId || 'acc_unknown', source, expiresAtMs });
    };
    const paths = [this.config.shardsJsonPath].filter(Boolean) as string[];
    for (const filename of new Set(paths)) {
      if (!fs.existsSync(filename)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
        const source = path.basename(path.dirname(filename)) + '/' + path.basename(filename);
        if (Array.isArray(data)) data.forEach(item => add(item, source));
        else {
          add(data, source);
          if (data.codexOAuth) add(data.codexOAuth, source);
          if (data.codexOAuthPool) Object.values(data.codexOAuthPool).forEach(item => add(item, source));
          if (Array.isArray(data.shards)) data.shards.forEach((item: any) => add(item, source));
        }
      } catch { console.warn('[Relay:Shards] Could not read a configured credential file'); }
    }
    this.installFleet(items);
    console.log(`[Relay:Shards] Loaded ${this.shardsTable.count()} unique account(s).`);
  }

  private async refreshShardRegistry(force = false): Promise<void> {
    if (!this.config.registryEnabled) return;
    if (this.registryRefresh) return this.registryRefresh;
    if (!force && Date.now() - this.registryRefreshedAtMs < 5000) {
      if (this.registryError) throw new Error(this.registryError);
      return;
    }
    this.registryRefresh = (async () => {
      try {
        const rows = await readShardRegistry();
        const items: Array<Partial<ShardRecord> & { accessToken: string; accountId: string }> = [];
        for (const row of rows) {
          if (!row.managed_desktop_id || !row.desktop_enrolled_at || row.provider !== 'openai' || row.permission_retracted || !['active', 'healthy', 'warming_up', 'half_open', 'cooldown', 'exhausted', 'rate_limited'].includes(row.status)) continue;
          const secret = decryptRegistryShard(row);
          if (!secret?.accessToken || !secret?.accountId) continue;
          items.push({ id: row.id, accessToken: secret.accessToken, accountId: secret.accountId,
            source: 'PostgreSQL registry', expiresAtMs: Number(row.credential_expires_at_ms) || Number(secret.expiresAtMs) || undefined,
            cooldownUntilMs: Number(row.cooldown_until_ms) || 0,
            status: Number(row.cooldown_until_ms) > Date.now() ? 'cooldown' : 'active',
          });
        }
        this.installFleet(items);
        this.registryCounts = { total: rows.length, skipped: rows.length - items.length };
        this.registryError = null;
      } catch (error) {
        this.registryError = error instanceof Error ? error.message : 'Shard registry unavailable';
        throw error;
      } finally {
        this.registryRefreshedAtMs = Date.now();
        this.registryRefresh = undefined;
      }
    })();
    return this.registryRefresh;
  }

  private async refreshCapabilities(): Promise<void> {
    if (this.capabilityRefresh) return this.capabilityRefresh;
    this.capabilityRefresh = (async () => {
      for (const shard of this.shardsTable.getAll()) {
        if (this.isDraining || shard.status === 'disabled') continue;
        const ticket = this.capabilities.beginRefresh(shard.id);
        if (!ticket) continue;
        const controller = new AbortController();
        this.capabilityControllers.add(controller);
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          const models = await (this.config.capabilityDiscovery ?? ((shard, signal) => discoverOpenAIModels(shard, signal, fetch, process.env.RELAY_CAPABILITY_INVENTORY_URL)))(shard, controller.signal);
          this.capabilities.publishInventory(ticket, models);
          this.capabilityError = undefined;
          this.maybeRefreshImageAlias(shard);
        } catch (error) {
          this.capabilityError = error instanceof CapabilityDiscoveryError ? error.code : 'inventory_unavailable';
          if (error instanceof CapabilityDiscoveryError && error.code === 'invalid_credential') {
            this.recordShardFailure(shard.id, true);
            this.capabilities.heartbeat(shard.id, { health: 'unavailable' });
          }
        } finally { clearTimeout(timeout); this.capabilityControllers.delete(controller); }
      }
    })();
    try { await this.capabilityRefresh; } finally { this.capabilityRefresh = undefined; }
  }

  private maybeRefreshImageAlias(shard: ShardRecord): void {
    if (this.config.executionPolicy) return; // Probes also require explicit central admission.
    if (!this.config.codexImageToolAlias || shard.accessToken.startsWith('sk-') || this.imageCapabilityProbe || this.isDraining || Date.now() < this.nextImageProbeAt) return;
    const ownership = this.runtimeOwnership(shard);
    if (this.shardReadyAt(shard, Date.now(), true) > Date.now() || shard.imageProbeInFlight || ownership.imageInFlight >= IMAGE_SHARD_CONCURRENCY
      || ownership.inFlight >= this.config.shardConcurrency || this.imageControllers.size) return;
    const record = this.capabilities.get(shard.id);
    if (!record || record.lastCapabilityRefreshMs + this.config.capabilityTtlMs <= Date.now()) return;
    const alias = record.models.find(m => m.model === `image:${CODEX_IMAGE_ALIAS.requestedModel}`);
    if (alias?.state === 'AVAILABLE' && alias.expiresAtMs > Date.now() + 600000) return;
    // One paid verification at startup, then at most once per 50 minutes when idle.
    // Real successful image requests renew the evidence and avoid extra probes.
    this.nextImageProbeAt = Date.now() + 600000;
    this.imageCapabilityProbe = this.verifyImageCapability(CODEX_IMAGE_ALIAS.requestedModel, 'A small blue ceramic bee on a plain cream background. No text.')
      .catch(() => { this.imageProbeFailures = Math.min(3, this.imageProbeFailures + 1); this.nextImageProbeAt = Date.now() + Math.min(3600000, 600000 * 2 ** (this.imageProbeFailures - 1)); })
      .finally(() => { this.imageCapabilityProbe = undefined; });
  }

  private async verifyImageCapability(model: string, prompt: string) {
    if (this.config.executionPolicy) throw new RequestError(403,'capability_unavailable','This action is unavailable.');
    const shard = this.shardsTable.getAll()[0];
    if (this.isDraining || !shard || this.shardReadyAt(shard, Date.now(), true) > Date.now() || shard.imageProbeInFlight
      || this.runtimeOwnership(shard).imageInFlight >= IMAGE_SHARD_CONCURRENCY || this.runtimeOwnership(shard).inFlight >= this.config.shardConcurrency
      || this.imageControllers.size) throw new RequestError(503, 'probe_busy', 'Shard is not ready for an image probe.');
    const execution = imageExecution(model, shard.accessToken.startsWith('sk-'), this.config.codexImageToolAlias);
    const alias = execution.routingMode === 'codex_image_tool_alias';
    const inventory = this.capabilities.get(shard.id);
    if (alias && (!inventory || inventory.lastCapabilityRefreshMs + this.config.capabilityTtlMs <= Date.now())) throw new RequestError(503, 'model_temporarily_unavailable', 'Fresh capability inventory is required.');
    const ticket = this.capabilities.beginObservation(shard.id, `image:${model}`)!;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    this.imageControllers.add(controller);
    const ownership = this.runtimeOwnership(shard);
    this.updateRuntimeOwnership(shard, ownership.inFlight + 1, ownership.imageInFlight + 1);
    try {
      const result = shard.accessToken.startsWith('sk-')
        ? await this.synthesizeImageViaOpenAiRest(prompt, {model}, shard.accessToken, controller.signal)
        : alias ? await generateCodexToolImage(prompt, shard, controller.signal, this.config.maxImagePayloadBytes)
        : await this.synthesizeImageViaCodex(prompt, execution.executionModel, shard, undefined, controller.signal);
      const bytes = Buffer.from(result.b64_json, 'base64');
      const valid = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        || (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
        || (bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP');
      if (!valid || bytes.length < 32) throw new RequestError(502, 'invalid_image', 'The upstream did not return a valid image payload.');
      const published = this.capabilities.observe(ticket, `image:${model}`, 'AVAILABLE', alias ? 'verified_codex_image_tool' : undefined, alias);
      if (alias && published) { this.imageProbeFailures = 0; this.nextImageProbeAt = Date.now() + 3000000; }
      return { verified: published, model, bytes: bytes.length, expiresInMs: alias ? IMAGE_TOOL_EVIDENCE_TTL_MS : this.config.capabilityTtlMs, ...execution };
    } catch (error: any) {
      const negative = classifyCapabilityFailure(imageFailureFrame(error));
      if (negative) this.capabilities.observe(ticket, `image:${model}`, negative.state, negative.reason, alias);
      throw error;
    } finally { clearTimeout(timeout); this.imageControllers.delete(controller); this.releaseShard(shard.id, false, true); }
  }

  private updateCapabilityHealth() {
    const queueDepth = this.jobsTable.getAll().filter(j => j.status === 'queued').length;
    for (const shard of this.shardsTable.getAll()) this.capabilities.heartbeat(shard.id, {
      activeStreams: shard.inFlight, capacity: this.config.shardConcurrency, recentErrors: shard.consecutiveFailures,
      health: this.isDraining || this.shardReadyAt(shard) > Date.now() ? 'unavailable' : 'healthy',
      queueDepth,
    });
  }

  /** In-process scheduling observation only; never an HTTP response or an execution grant. */
  accountAvailabilityObservation(model: string) {
    return this.accountAvailability(model);
  }

  /** Read-only observation for the owning Premium runtime; never starts a probe. */
  imageAvailability(): boolean | null {
    if (this.config.executionPolicy?.pool !== 'premium' || !this.config.codexImageToolAlias || this.isDraining || this.credentialRejected()) return false;
    const observed = this.capabilities.get(this.config.assignedShardId!)?.models.find(m => m.model === `image:${CODEX_IMAGE_ALIAS.requestedModel}`);
    // Chat inventory cannot authorize or deny the separate image tool. Expired
    // evidence permits a centrally authorized explicit trial, not an availability claim.
    if (!observed || observed.source !== 'response' || observed.expiresAtMs <= Date.now() || observed.state === 'UNKNOWN') return null;
    return observed.state === 'AVAILABLE' && observed.routingMode === CODEX_IMAGE_ALIAS.routingMode;
  }

  accountAvailability(model: string, authorizedImageTrial = false) {
    const shard = this.config.executionPolicy && this.config.assignedShardId
      ? this.shardsTable.get(this.config.assignedShardId) : undefined;
    if (!shard) return { eligible: false, lastUsedAtMs: 0, recovering: false, availableSlots: 0 };
    this.updateCapabilityHealth();
    const imageWorkload = authorizedImageTrial || model.startsWith('image:');
    const recovering = imageWorkload
      ? Boolean(shard.imageQuotaFailures || shard.imageConsecutiveFailures && shard.imageConsecutiveFailures >= 3)
      : Boolean(shard.quotaFailures || shard.consecutiveFailures >= 3);
    const readyAt = this.shardReadyAt(shard, Date.now(), imageWorkload);
    const probeInFlight = imageWorkload ? shard.imageProbeInFlight : shard.probeInFlight;
    const ownership = this.runtimeOwnership(shard);
    const active = Math.max(ownership.inFlight, this.jobsTable.getAll().filter(j => ['queued','running','streaming'].includes(j.status)).length);
    const previous = this.capabilities.get(shard.id)?.models.find(m => m.model === model);
    const trial = authorizedImageTrial && this.config.executionPolicy?.pool === 'premium'
      && (!previous || previous.source !== 'response' || previous.state === 'AVAILABLE' || previous.expiresAtMs <= Date.now());
    const capacity = imageWorkload ? IMAGE_SHARD_CONCURRENCY : this.config.shardConcurrency;
    const availableSlots = imageWorkload
      ? (ownership.imageInFlight >= capacity || ownership.inFlight >= this.config.shardConcurrency ? 0 : capacity)
      : Math.max(0, (recovering ? Math.min(1, capacity) : capacity) - active);
    return {
      eligible: !this.isDraining && readyAt <= Date.now() && !probeInFlight && availableSlots > 0
        && (trial || this.capabilities.eligibleShardIds(model).includes(shard.id)),
      lastUsedAtMs: shard.lastUsedAtMs,
      recovering, availableSlots,
    };
  }

  /** Private, revision-scoped observation for the owning pool; never revokes account permission. */
  credentialRejected() {
    return Boolean(this.config.assignedShardId && this.shardsTable.get(this.config.assignedShardId)?.status === 'disabled');
  }

  private capabilitySnapshot() {
    this.updateCapabilityHealth();
    // Rejection survives checkpoint recovery and can also originate in inference.
    // Discovery skips disabled credentials, so its transient error is insufficient.
    const shards = this.shardsTable.getAll();
    const rejected = shards.length === 1 && shards[0].status === 'disabled';
    return { ...this.capabilities.snapshot(), error: rejected ? 'invalid_credential'
      : this.capabilityError === 'invalid_credential' ? undefined : this.capabilityError };
  }

  private rejectModelCapacity(res: http.ServerResponse, model: string): void {
    this.updateCapabilityHealth();
    const eligible = this.capabilities.eligible(model);
    const imageWorkload = model.startsWith('image:');
    const code = eligible.length ? 'model_capacity_exhausted' : 'model_temporarily_unavailable';
    const now = Date.now();
    const deadlines = this.shardsTable.getAll().filter(s => this.capabilities.get(s.id)?.models.some(m => m.model === model && m.state === 'AVAILABLE' && m.expiresAtMs > now))
      .map(s => this.shardReadyAt(s, now, imageWorkload)).filter(Number.isFinite);
    const retryAfter = deadlines.length ? Math.max(5, Math.ceil((Math.min(...deadlines) - now) / 1000)) : 5;
    res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter), 'X-Should-Retry': 'true', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: { code, model, message: eligible.length
      ? `All eligible relays for ${model} are busy. Retry after ${retryAfter} seconds.`
      : `No healthy relay currently has verified access to ${model}. No substitute model was used.` } }));
  }

  private tuneSocket(ws: any): void {
    try {
      const sock = ws._socket || ws.socket || (ws._client && ws._client._socket);
      if (sock) {
        if (typeof sock.setNoDelay === 'function') {
          sock.setNoDelay(true); // Disable Nagle's algorithm for sub-millisecond token dispatch
        }
        if (typeof sock.setKeepAlive === 'function') {
          sock.setKeepAlive(true, 10_000); // 10s transport TCP keep-alive probe
        }
      }
    } catch {}
  }

  private safeCloseSocket(ws: any, code = 1000, reason = 'Normal closure'): void {
    if (!ws) return;
    try {
      // Detach listeners to prevent memory leaks and zombie callback re-entry
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (typeof ws.removeAllListeners === 'function') {
        ws.removeAllListeners();
        // terminate() can emit an asynchronous error while the handshake closes.
        ws.on('error', () => {});
      }
      if (typeof ws.terminate === 'function') {
        ws.terminate();
      } else if (typeof ws.close === 'function') {
        ws.close(code, reason);
      }
    } catch {}
  }

  private shardReadyAt(shard: ShardRecord, now = Date.now(), imageWorkload = false): number {
    if (shard.status === 'disabled' || (shard.expiresAtMs && shard.expiresAtMs <= now)) return Infinity;
    let deadline = imageWorkload ? shard.imageCooldownUntilMs ?? 0 : shard.cooldownUntilMs ?? 0;
    if (!imageWorkload && shard.status === 'cooldown' && !deadline) deadline = shard.lastUsedAtMs + 60_000;
    const cap = this.currentQuotaProfile.maxCalls;
    const usage = shard.slidingWindowTimestamps.filter(t => t > now - this.currentQuotaProfile.windowDurationMs);
    if (cap > 0 && usage.length >= cap) deadline = Math.max(deadline, usage[usage.length - cap] + this.currentQuotaProfile.windowDurationMs);
    return deadline;
  }

  private fleetRetryAfter(imageWorkload = false): number | null {
    const now = Date.now();
    const deadlines = this.shardsTable.getAll().map(s => this.shardReadyAt(s, now, imageWorkload)).filter(Number.isFinite);
    return deadlines.length ? Math.max(1, Math.ceil((Math.min(...deadlines) - now) / 1000)) : null;
  }

  private acquireHealthyShard(exclude?: string | Set<string>, model?: string, authorizedImageTrial = false, jobId?: string): ShardRecord | null {
    if (!model || authorizedImageTrial && this.config.executionPolicy?.pool !== 'premium') return null;
    const imageWorkload = authorizedImageTrial || model.startsWith('image:');
    const capacity = imageWorkload ? IMAGE_SHARD_CONCURRENCY : this.config.shardConcurrency;
    this.updateCapabilityHealth();
    const eligibleIds = new Set(this.capabilities.eligibleShardIds(model));
    if (authorizedImageTrial && this.config.assignedShardId) {
      const previous = this.capabilities.get(this.config.assignedShardId)?.models.find(m=>m.model===model);
      if (!previous || previous.state === 'AVAILABLE' || previous.expiresAtMs <= Date.now()) eligibleIds.add(this.config.assignedShardId);
    }
    const now = Date.now();
    if (this.config.registryEnabled && (this.registryError || now - this.registryRefreshedAtMs > 5000)) return null;
    const all = [...eligibleIds].map(id => this.shardsTable.get(id)!).filter(Boolean);
    let candidate: ShardRecord | null = null;
    let selectedIndex = 0;
    for (let step = 0; step < all.length; step++) {
      const index = (this.shardCursor + step) % all.length;
      const shard = all[index];
      if (typeof exclude === 'string' ? shard.id === exclude : exclude?.has(shard.id)) continue;
      const ownership = this.runtimeOwnership(shard);
      const recovering = imageWorkload
        ? Boolean(shard.imageQuotaFailures || (shard.imageConsecutiveFailures ?? 0) >= 3)
        : Boolean(shard.quotaFailures || shard.consecutiveFailures >= 3);
      const probeInFlight = imageWorkload ? shard.imageProbeInFlight : shard.probeInFlight;
      if (this.shardReadyAt(shard, now, imageWorkload) > now || probeInFlight
        || (imageWorkload ? ownership.imageInFlight >= capacity || ownership.inFlight >= this.config.shardConcurrency : ownership.inFlight >= capacity)) continue;
      // After a cooldown, admit exactly one probe only when previous work drained.
      if (recovering && ownership.inFlight > 0) continue;
      const shardLoad = imageWorkload ? ownership.imageInFlight : ownership.inFlight;
      const candidateOwnership = candidate ? this.runtimeOwnership(candidate) : undefined;
      const candidateLoad = candidate ? imageWorkload ? candidateOwnership!.imageInFlight : candidateOwnership!.inFlight : Infinity;
      if (!candidate || shardLoad < candidateLoad) { candidate = shard; selectedIndex = index; }
    }
    if (!candidate) return null;
    this.shardCursor = (selectedIndex + 1) % all.length;
    const probe = imageWorkload
      ? Boolean(candidate.imageQuotaFailures || (candidate.imageConsecutiveFailures ?? 0) >= 3)
      : Boolean(candidate.quotaFailures || candidate.consecutiveFailures >= 3);
    const ownership = this.runtimeOwnership(candidate);
    const updated: ShardRecord = {
      ...candidate,
      status: imageWorkload ? candidate.status : 'active',
      probeInFlight: imageWorkload ? candidate.probeInFlight : probe,
      ...(imageWorkload ? { imageProbeInFlight: probe } : {}),
      inFlight: ownership.inFlight + 1, imageInFlight: ownership.imageInFlight + (imageWorkload ? 1 : 0), lastUsedAtMs: now,
      slidingWindowTimestamps: [...candidate.slidingWindowTimestamps.filter(t => t > now - this.currentQuotaProfile.windowDurationMs), now],
      providerLimits: (candidate.providerLimits ?? []).filter(l => (!l.resetAtMs || l.resetAtMs > now)
        // An elapsed fallback permits a real probe. Old zero observations without a reset
        // must not immediately reopen the same cooldown before that probe can run.
        && !(this.config.executionPolicy && probe && !l.resetAtMs && l.remaining === 0)).map(l => ({
        ...l, remaining: /request/i.test(l.name) ? Math.max(0, l.remaining - 1) : l.remaining,
      })),
    };
    const depleted = (updated.providerLimits ?? []).filter(l => l.remaining === 0);
    if (depleted.length) {
      const deadline = Math.max(...depleted.map(l => l.resetAtMs ?? now + 60_000));
      if (imageWorkload) {
        updated.imageCooldownUntilMs = Math.max(updated.imageCooldownUntilMs ?? 0, deadline);
        updated.imageQuotaFailures = Math.max(1, updated.imageQuotaFailures ?? 0);
      } else {
        updated.cooldownUntilMs = Math.max(updated.cooldownUntilMs ?? 0, deadline);
        updated.status = 'cooldown';
        updated.quotaFailures = Math.max(1, updated.quotaFailures ?? 0);
      }
      if (this.config.executionPolicy && jobId) {
        updated.lastQuotaFailureJobId = jobId;
        const session = this.sessions.get(jobId); if (session) session.quotaFailureObserved = true;
      }
    }
    this.updateRuntimeOwnership(updated, updated.inFlight, updated.imageInFlight ?? 0);
    if (this.config.executionPolicy) this.saveStateSnapshot();
    return updated;
  }

  private recordQuotaFailure(shardId: string, providerDeadline?: number, release = true, jobId?: string, imageWorkload = false): void {
    const shard = this.shardsTable.get(shardId);
    if (!shard) {
      if (release) this.releaseRuntimeOwnership(shardId, imageWorkload);
      return;
    }
    const ownership = this.runtimeOwnership(shard);
    const executionJob = this.config.executionPolicy ? jobId : undefined;
    const session = executionJob ? this.sessions.get(executionJob) : undefined;
    const previousQuotaJob = imageWorkload ? shard.lastImageQuotaFailureJobId : shard.lastQuotaFailureJobId;
    const repeatedObservation = session?.quotaFailureObserved || (executionJob !== undefined && previousQuotaJob === executionJob);
    if (session) session.quotaFailureObserved = true;
    const failures = Math.max(1, ((imageWorkload ? shard.imageQuotaFailures : shard.quotaFailures) ?? 0) + (repeatedObservation ? 0 : 1));
    // New evidence can extend the wait; multiple frames cannot multiply the same job's backoff.
    const deadline = cooldownDeadline(failures, Date.now(), providerDeadline);
    const updated: ShardRecord = { ...shard,
      inFlight: Math.max(0, ownership.inFlight - (release ? 1 : 0)),
      imageInFlight: Math.max(0, ownership.imageInFlight - (imageWorkload && release ? 1 : 0)),
      ...(imageWorkload ? {
        imageQuotaFailures: failures,
        imageProbeInFlight: false,
        imageCooldownUntilMs: Math.max(shard.imageCooldownUntilMs ?? 0, deadline),
        ...(executionJob ? { lastImageQuotaFailureJobId: executionJob } : {}),
      } : {
        status: shard.status === 'disabled' ? 'disabled' : 'cooldown',
        quotaFailures: failures,
        probeInFlight: false,
        ...(executionJob ? { lastQuotaFailureJobId: executionJob } : {}),
        cooldownUntilMs: Math.max(shard.cooldownUntilMs ?? 0, deadline),
      }),
    };
    this.updateRuntimeOwnership(updated, updated.inFlight, updated.imageInFlight ?? 0);
    if (this.config.executionPolicy) this.saveStateSnapshot();
  }

  private recordShardFailure(shardId: string, unauthorized = false, imageWorkload = false): void {
    const shard = this.shardsTable.get(shardId);
    if (!shard) { this.releaseRuntimeOwnership(shardId, imageWorkload); return; }
    const ownership = this.runtimeOwnership(shard);
    const failures = shard.consecutiveFailures + 1;
    const imageFailures = (shard.imageConsecutiveFailures ?? 0) + 1;
    const imageDeadline = unauthorized
      ? Date.now() + 120_000
      : imageFailures >= 3 ? cooldownDeadline(imageFailures - 2, Date.now()) : shard.imageCooldownUntilMs;
    const updated: ShardRecord = { ...shard,
      inFlight: Math.max(0, ownership.inFlight - 1),
      imageInFlight: Math.max(0, ownership.imageInFlight - (imageWorkload ? 1 : 0)),
      ...(imageWorkload ? {
        imageConsecutiveFailures: imageFailures,
        imageProbeInFlight: false,
        ...(imageDeadline === undefined ? {} : { imageCooldownUntilMs: Math.max(shard.imageCooldownUntilMs ?? 0, imageDeadline) }),
      } : {
        probeInFlight: false,
        consecutiveFailures: failures,
        status: unauthorized || shard.status === 'disabled' ? 'disabled' : failures >= 3 ? 'cooldown' : shard.status,
        cooldownUntilMs: failures >= 3 ? Math.max(shard.cooldownUntilMs ?? 0, cooldownDeadline(failures - 2, Date.now())) : shard.cooldownUntilMs,
      }),
    };
    this.updateRuntimeOwnership(updated, updated.inFlight, updated.imageInFlight ?? 0);
    if (unauthorized || this.config.executionPolicy) this.saveStateSnapshot();
  }

  private releaseShard(shardId: string, succeeded = false, imageWorkload = false): void {
    const shard = this.shardsTable.get(shardId);
    if (!shard) { this.releaseRuntimeOwnership(shardId, imageWorkload); return; }
    const ownership = this.runtimeOwnership(shard);
    if (ownership.inFlight <= 0) return;
    const needsProbe = this.config.executionPolicy && (imageWorkload
      ? Boolean(shard.imageQuotaFailures || (shard.imageConsecutiveFailures ?? 0) >= 3)
      : Boolean(shard.quotaFailures || shard.consecutiveFailures >= 3));
    const probeInFlight = imageWorkload ? shard.imageProbeInFlight : shard.probeInFlight;
    const readyAt = this.shardReadyAt(shard, Date.now(), imageWorkload);
    // A pre-exhaustion sibling finishing late is not evidence that a recovery probe succeeded.
    const recovered = succeeded && readyAt <= Date.now() && (!needsProbe || probeInFlight);
    const updated = { ...shard,
      inFlight: ownership.inFlight - 1,
      imageInFlight: Math.max(0, ownership.imageInFlight - (imageWorkload ? 1 : 0)),
      ...(imageWorkload ? {
        imageProbeInFlight: false,
        ...(recovered ? { imageConsecutiveFailures: 0, imageQuotaFailures: 0, imageCooldownUntilMs: 0 } : {}),
      } : {
        probeInFlight: false,
        ...(recovered ? { consecutiveFailures: 0, quotaFailures: 0, status: shard.status === 'disabled' ? 'disabled' as const : 'active' as const } : {}),
      }),
    };
    this.updateRuntimeOwnership(updated, updated.inFlight, updated.imageInFlight ?? 0);
    if (this.config.executionPolicy && recovered && (imageWorkload
      ? (shard.imageQuotaFailures || (shard.imageConsecutiveFailures ?? 0) >= 3)
      : (shard.quotaFailures || shard.consecutiveFailures >= 3))) this.saveStateSnapshot();
  }

  private getRateLimitHeaders(): Record<string, string> {
    const cap = this.currentQuotaProfile.maxCalls;
    return {
      'X-RateLimit-Mode': this.currentQuotaProfile.mode,
      'X-RateLimit-Policy': cap > 0 ? `${cap};w=${this.currentQuotaProfile.windowDurationMs / 1000}` : 'provider-feedback;local-cap=none',
      ...(cap > 0 ? { 'X-RateLimit-Limit': String(cap * this.shardsTable.count()) } : {}),
    };
  }

  private rejectUnavailableFleet(res: http.ServerResponse, imageWorkload = false): void {
    const retry = this.fleetRetryAfter(imageWorkload);
    res.writeHead(503, { 'Content-Type': 'application/json', ...(retry === null ? {} : { 'Retry-After': String(retry) }), ...this.getRateLimitHeaders() });
    res.end(JSON.stringify({ error: {
      code: 'all_shards_unavailable',
      message: retry === null ? 'No usable credentials. Refresh or enroll an account.' : `No shard is ready. Retry after ${retry}s.`,
      retry_after_seconds: retry,
    } }));
  }

  // --------------------------------------------------------------------------
  // HTTP INGRESS ROUTER
  // --------------------------------------------------------------------------

  private admissionState() {
    const rssBytes = process.memoryUsage().rss;
    const reason = this.isDraining ? 'server_draining'
      : rssBytes >= this.config.maxRssBytes ? 'relay_memory_pressure'
      : this.admittedRequests >= this.config.maxConcurrentRequests ? 'relay_overloaded' : null;
    return { accepting: reason === null, reason, activeRequests: this.admittedRequests,
      maxConcurrentRequests: this.config.maxConcurrentRequests, rssBytes, maxRssBytes: this.config.maxRssBytes };
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.config.stagedPool !== undefined) {
      return stagedPoolRequest(req, res, this.config.stagedPool, () => this.verifyAuthorization(req, true));
    }
    const parsedUrl = url.parse(req.url || '', true);
    const pathname = parsedUrl.pathname || '';
    const method = req.method?.toUpperCase() || 'GET';

    const isInference = method === 'POST' && /^\/(v1\/)?(chat\/completions|images\/generations)$/.test(pathname);
    if (isInference) {
      const traceId = this.telemetry.start(pathname.includes('images') ? 'Image generation' : 'Chat completion', req.headers['x-galx-task-id']);
      this.requestTraces.set(req, traceId);
      res.setHeader('X-Galx-Trace-Id', traceId);
      res.once('finish', () => {
        this.telemetry.http(traceId, res.statusCode);
        if (res.statusCode !== 202) this.telemetry.finish(traceId, res.statusCode < 400 ? 'completed' : 'failed',
          res.statusCode >= 400 ? `http_${res.statusCode}` : undefined,
          [400, 401, 408, 409, 413, 422].includes(res.statusCode) ? 'client' : 'relay');
      });
      res.once('close', () => {
        if (!res.writableFinished) this.telemetry.finish(traceId, 'cancelled', 'client_disconnect', 'client');
      });
    }
    res.setHeader('Access-Control-Expose-Headers', 'X-Nova-Job-Id, X-Galx-Trace-Id, X-Galx-Job-Id, Retry-After, Location, Operation-Location');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
    res.setHeader('Vary', 'Origin');
    const authenticatedMode = Boolean(this.config.apiKeys?.length || this.config.adminApiKeys?.length);
    let host: URL;
    try { host = new URL(`http://${req.headers.host}`); } catch {
      res.writeHead(400); res.end('Invalid Host header'); return;
    }
    if (!authenticatedMode && !['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'untrusted_host', message: 'Local unauthenticated access requires a loopback hostname.' } })); return;
    }
    const origin = req.headers.origin;
    const sameOrigin = origin === `http://${host.host}` || origin === `https://${host.host}`;
    const allowedOrigin = typeof origin === 'string' && (sameOrigin || (authenticatedMode && this.config.allowedOrigins?.includes(origin)));
    if ((origin && !allowedOrigin) || (!origin && req.headers['sec-fetch-site'] === 'cross-site')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'origin_not_allowed', message: 'This browser origin is not allowed to access the relay.' } })); return;
    }
    if (origin && allowedOrigin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Last-Event-ID, X-Requested-With, X-Tenant-Id, X-Galx-Api-Key, X-Galx-Task-Id, Idempotency-Key');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/health' || pathname === '/health/ready' || pathname === '/health/live') {
      this.handleHealth(res, pathname === '/health/ready');
      return;
    }

    if (pathname === '/telemetry' || pathname === '/telemetry/') {
      this.handleDashboard(res, 'telemetry.html');
      return;
    }

    if (pathname === '/' || pathname === '/dashboard' || pathname === '/dashboard/') {
      this.handleDashboard(res);
      return;
    }

    if (!this.verifyAuthorization(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'Invalid or missing API key' } }));
      return;
    }
    if ((pathname.startsWith('/api/') || pathname === '/metrics') && !this.verifyAuthorization(req, true)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'admin_access_required', message: 'Use a relay administrator key for fleet controls and telemetry.' } })); return;
    }
    if (pathname.startsWith('/api/') && !this.checkTenantRateLimit(`admin:${this.principals.get(req) ?? req.socket.remoteAddress}`)) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
      res.end(JSON.stringify({ error: { code: 'management_rate_limited', message: 'Too many management requests. Retry after one second.' } })); return;
    }
    if (pathname === '/metrics') { this.handleMetrics(res); return; }
    if (pathname === '/api/capabilities/probe-image' && method === 'POST') {
      try {
        const body = await readJsonBody(req, 16384, this.config.httpBodyTimeoutMs);
        validateModelRequest(body, true);
        if (!body.model) throw new RequestError(400, 'model_required', 'Specify the exact image execution model.');
        if (this.isDraining) throw new RequestError(503, 'server_draining', 'Relay is draining.');
        const result = await this.verifyImageCapability(body.model, body.prompt);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(result));
      } catch (error) {
        const failure = error instanceof RequestError ? error : new RequestError(502, 'image_probe_failed', 'Image capability verification failed.');
        res.writeHead(failure.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: failure.code, message: failure.message } }));
      }
      return;
    }
    if (pathname === '/api/sites/contract') {
      try {
        if (method !== 'GET' || !this.config.adminApiKeys?.length ||
            !this.admissionState().accepting) throw new Error();
        const request = sitesContractRequest(new URL(req.url!, 'http://localhost').searchParams);
        if (request.profile !== 'sites-local-v1' && this.config.forwardOutputTokenLimit !== true) throw new Error();
        this.updateCapabilityHealth();
        if (!this.capabilities.eligible(request.model).length) throw new Error();
        this.receiptStore().verifyReady();
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(sitesContractReply(request)));
      } catch {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'service_unavailable', message: 'This request is temporarily unavailable.' } }));
      }
      return;
    }
    if (pathname === '/api/capabilities' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(this.capabilitySnapshot()));
      return;
    }
    if (pathname === '/api/telemetry' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ...this.telemetry.snapshot(), server: { admission: this.admissionState(), uptimeSec: process.uptime(), rssBytes: process.memoryUsage().rss, retryBudget: this.retryBudget.snapshot(), eventLoopP99Ms: this.eventLoopDelay.count ? this.eventLoopDelay.percentile(99) / 1e6 : null } }));
      return;
    }
    if (isInference || (method === 'POST' && pathname.startsWith('/api/'))) {
      const admission = this.admissionState();
      if (!admission.accepting) {
        const traceId = this.requestTraces.get(req);
        if (traceId) this.telemetry.finish(traceId, 'failed', admission.reason!, 'relay');
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2', 'Connection': 'close' });
        res.end(JSON.stringify({ error: { code: admission.reason, message: admission.reason === 'server_draining'
          ? 'Relay is restarting. Retry after 2 seconds.'
          : 'Relay is at capacity. Retry after 2 seconds; no provider request was started.' } }));
        return;
      }
      this.admittedRequests++;
      let released = false;
      const release = () => { if (!released) { released = true; this.admittedRequests--; } };
      res.once('finish', release); res.once('close', release);
    }
    // Job controls must remain available when credential discovery is down.
    try { if (isInference || pathname.startsWith('/api/')) await this.refreshShardRegistry(); }
    catch {
      if (!pathname.startsWith('/api/')) {
        const traceId = this.requestTraces.get(req);
        if (traceId) this.telemetry.finish(traceId, 'failed', 'shard_registry_unavailable');
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5' });
        res.end(JSON.stringify({ error: { code: 'shard_registry_unavailable', message: 'Shard registry unavailable. Retry after 5s.' } }));
        return;
      }
    }

    if (pathname === '/api/dashboard/stats') {
      this.handleDashboardStats(res);
      return;
    }

    if (pathname === '/api/quota/profile' && method === 'POST') {
      await this.handleSetQuotaProfile(req, res);
      return;
    }

    if (pathname === '/api/quota/reset' && method === 'POST') {
      await this.handleResetQuota(req, res);
      return;
    }

    if (pathname === '/api/quota/status' && method === 'GET') {
      this.handleQuotaStatus(res);
      return;
    }

    if (pathname === '/api/shards/sync' && method === 'POST') {
      await this.handleSyncShards(req, res);
      return;
    }

    if (pathname === '/api/shards/enroll' && method === 'POST') {
      await this.handleEnrollShard(req, res);
      return;
    }

    if (pathname === '/api/shards' && method === 'GET') {
      this.handleListShards(res);
      return;
    }

    // Multi-Tenant Rate Limiting Gate
    const delegatedTenant = req.headers['x-galx-tenant'];
    const tenantId = this.config.assignedShard && this.principals.has(req) && typeof delegatedTenant === 'string' && /^[a-f0-9]{64}$/.test(delegatedTenant)
      ? delegatedTenant : this.principals.get(req) || req.socket.remoteAddress || 'tenant_default';
    if (!this.checkTenantRateLimit(pathname.startsWith('/v1/jobs/') ? `control:${tenantId}` : tenantId)) {
      const traceId = this.requestTraces.get(req);
      if (traceId) this.telemetry.finish(traceId, 'failed', 'relay_rate_limited', 'relay');
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '1',
        ...this.getRateLimitHeaders(),
      });
      res.end(JSON.stringify({ error: { message: 'Rate limit exceeded. Please retry in 1s.', code: 'rate_limited' } }));
      return;
    }

    if (this.isDraining && isInference) {
      const traceId = this.requestTraces.get(req);
      if (traceId) this.telemetry.finish(traceId, 'failed', 'server_draining');
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Relay server is draining for reload', code: 'server_draining' } }));
      return;
    }

    if (method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
      this.updateCapabilityHealth();
      const snapshot = this.capabilities.snapshot();
      const models = snapshot.models
        .filter(m => m.state !== 'UNAVAILABLE')
        .map(m => m.model);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: models.map(id => ({
          id,
          object: 'model',
          created: Math.floor(this.metrics.startTimeMs / 1000),
          owned_by: 'relay'
        }))
      }));
      return;
    }

    if (method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/chat/completions')) {
      await this.handleChatCompletions(req, res, tenantId);
      return;
    }

    if (method === 'POST' && (pathname === '/v1/images/generations' || pathname === '/images/generations')) {
      await this.handleImageGenerations(req, res, tenantId);
      return;
    }

    const receiptRoute = pathname.match(/^\/v1\/jobs\/([\w-]{1,128})\/receipt$/);
    if (method === 'GET' && receiptRoute) {
      try {
        const receipt = this.receiptStore().lookup(receiptRoute[1], tenantId);
        res.writeHead(receipt ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(receipt ?? { error: { code: 'job_not_found' } }));
      } catch {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'receipt_unavailable' } }));
      }
      return;
    }
    const ownedJobRoute = pathname.match(/^\/v1\/jobs\/([^/]+)(?:\/(?:stream|cancel))?$/);
    if (ownedJobRoute) {
      const job = this.jobsTable.get(ownedJobRoute[1]);
      if (!job || job.tenantId !== tenantId) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'job_not_found', message: 'Job not found or no longer retained.' } }));
        return;
      }
    }
    const streamMatch = pathname.match(/^\/v1\/jobs\/([^/]+)\/stream$/);
    if (method === 'GET' && streamMatch) {
      const jobId = streamMatch[1];
      this.handleJobStream(jobId, req, res, parsedUrl.query);
      return;
    }

    const jobMatch = pathname.match(/^\/v1\/jobs\/([^/]+)$/);
    if (method === 'GET' && jobMatch) {
      const jobId = jobMatch[1];
      this.handleJobStatus(jobId, res);
      return;
    }

    const cancelMatch = pathname.match(/^\/v1\/jobs\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancelMatch) {
      const jobId = cancelMatch[1];
      this.handleJobCancel(jobId, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Route not found: ${method} ${pathname}`, code: 'not_found' } }));
  }

  // --------------------------------------------------------------------------
  // ATOMIC IDEMPOTENT ATTACHMENT & HTTP 202 ASYNC DECOUPLING
  // --------------------------------------------------------------------------

  private async handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse, tenantId: string): Promise<void> {
    let pendingGrant: ExecutionGrant | undefined;
    try {
        const body = await readJsonBody(req, this.config.maxPayloadBytes, this.config.httpBodyTimeoutMs);
        const poolWorkload = this.config.executionPolicy ? requestWorkload(this.config.executionPolicy.pool,req.url ?? '',body) : undefined;
        if (this.isDraining) throw new RequestError(503, 'server_draining', 'Relay is restarting. Submit the request again after it is ready.');
        validateModelRequest(body, false);
        if (body.durable_receipt !== undefined && typeof body.durable_receipt !== 'boolean') throw new RequestError(400, 'invalid_request', 'Invalid receipt request.');
        if (body.require_output_limit !== undefined && typeof body.require_output_limit !== 'boolean') throw new RequestError(400, 'invalid_request', 'Invalid request.');
        if (body.sites_profile !== undefined && (body.sites_profile !== 'local-v1' || body.durable_receipt !== true ||
            body.require_output_limit === true || body.max_tokens !== undefined)) throw new RequestError(400, 'invalid_request', 'Invalid request.');
        if (body.require_output_limit === true) {
          if (body.durable_receipt !== true || body.max_tokens === undefined) throw new RequestError(400, 'invalid_request', 'Invalid request.');
          if (this.config.forwardOutputTokenLimit !== true) throw new RequestError(503, 'service_unavailable', 'This request is temporarily unavailable.');
        }
        if (body.durable_receipt === true && Buffer.byteLength(JSON.stringify(body.messages)) > 12000) throw new RequestError(413, 'request_too_large', 'Request is too large.');
        const requestedModel = body.model || 'gpt-5.6-terra';
        const model = requestedModel;
        this.telemetry.model(this.requestTraces.get(req), requestedModel, model);
        const messages = body.messages || [{ role: 'user', content: 'Hello' }];
        const prompt = messages[messages.length - 1]?.content || '';
        const reasoningEffort = body.reasoning_effort || body.reasoningEffort || 'medium';

        // Atomic Idempotent Stream Attachment via BroccoliDB
        const operationKey = req.headers['idempotency-key'];
        if (operationKey !== undefined && (typeof operationKey !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(operationKey))) throw new RequestError(400, 'invalid_request', 'Invalid request key.');
        const functionContract = functionToolContract(body);
        const identity: unknown[] = [tenantId, model, reasoningEffort, body.max_tokens ?? 3500, messages];
        if (functionContract.tools.length) identity.push(functionContract);
        if (operationKey !== undefined || body.durable_receipt === true) identity.push(operationKey ?? null, body.durable_receipt === true);
        if (body.require_output_limit === true) identity.push('bounded-output-v1');
        if (body.sites_profile === 'local-v1') identity.push('sites-local-v1');
        const promptHash = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
        const existingIdempotency = this.idempotencyTable.get(promptHash);

        if (existingIdempotency) {
          const existingJob = this.jobsTable.get(existingIdempotency.jobId);
          if (existingJob && (existingJob.status === 'queued' || existingJob.status === 'running' || existingJob.status === 'streaming')) {
            this.metrics.totalAttachedDuplicates++;
            const duplicateTrace = this.requestTraces.get(req);
            if (duplicateTrace) {
              this.telemetry.attach(duplicateTrace, existingJob.id);
            }
            const streamUrl = `/v1/jobs/${existingJob.id}/stream`;
            res.writeHead(202, {
              'Content-Type': 'application/json',
              'Location': streamUrl,
              'X-Attached-Stream': 'true',
              'X-Nova-Job-Id': existingJob.id,
              'X-Galx-Job-Id': existingJob.id,
              'Operation-Location': `/v1/jobs/${existingJob.id}`,
              'Retry-After': '2',
              ...this.getRateLimitHeaders(),
            });
            res.end(JSON.stringify({
              id: existingJob.id,
              object: 'chat.completion.job',
              status: existingJob.status,
              model: existingJob.model,
              streamUrl,
              isAttachedDuplicate: true,
              statusUrl: `/v1/jobs/${existingJob.id}`,
              traceId: this.requestTraces.get(req),
              pollAfterMs: 2000,
              queuePosition: null,
              estimatedWaitSec: null,
              createdAt: Math.floor(existingJob.createdAtMs / 1000),
            }));
            return;
          }
        }

        this.updateCapabilityHealth();
        if (!this.capabilities.select(model)) {
          this.rejectModelCapacity(res, model);
          return;
        }

        // Register Fresh Job in BroccoliDB
        const jobId = `job_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
        pendingGrant = await this.config.executionPolicy?.admit(req,body,tenantId,jobId);
        pendingGrant?.assert();
        const jobRecord: JobRecord = {
          id: jobId,
          model,
          prompt,
          promptHash,
          tenantId,
          messagesJson: JSON.stringify(messages),
          ...(functionContract.tools.length ? { functionContract } : {}),
          reasoningEffort,
          status: 'queued',
          createdAtMs: Date.now(),
          seqCounter: 0,
          isDetached: false,
          estimatedTokens: body.max_tokens || 3500,
          durableReceipt: body.durable_receipt === true,
          ...(body.max_tokens !== undefined ? { maxOutputTokens: body.max_tokens } : poolWorkload === 'text' ? { maxOutputTokens: 4096 } : {}),
        };

        const traceId = this.requestTraces.get(req);
        if (traceId) { jobRecord.traceId = traceId; this.telemetry.bind(traceId, jobId); this.telemetry.phase(traceId, 'Shard selection', 'relay'); }
        if (jobRecord.durableReceipt) {
          try { this.receiptStore().reserve(jobId, tenantId, promptHash); }
          catch { throw new RequestError(503, 'receipt_unavailable', 'Durable result storage is unavailable.'); }
        }
        this.jobQueue.enqueue(jobRecord);
        this.idempotencyTable.put(promptHash, { id: promptHash, jobId, createdAtMs: Date.now() }, { ttlMs: this.config.idempotencyTtlMs });

        const session: TransientJobSession = {
          abortController: new AbortController(),
          ...(poolWorkload === 'text' && !this.config.forwardOutputTokenLimit
            ? { outputBudget: new OutputBudget(jobRecord.maxOutputTokens!) } : {}),
          lastChunkAtMs: 0,
          ewmaItlMs: 0,
          consecutiveItlStalls: 0,
          retryCount: 0,
          lastSeenAliveMs: Date.now(),
          activeTtftDeadlineMs: this.config.wsTtftTimeoutMs,
          activeAttemptId: 0,
          attemptedShardIds: new Set(),
        };

        // Layer 6: Absolute Wall Clock Ceiling (300s) attached to session across failovers
        session.wallTimer = setTimeout(() => {
          if (this.jobQueue.markFailed(jobId, 'job_wall_time_exceeded')) this.metrics.totalJobsFailed++;
          if (session.downstreamFailoverKeepaliveTimer) {
            clearInterval(session.downstreamFailoverKeepaliveTimer);
            session.downstreamFailoverKeepaliveTimer = undefined;
          }
          session.abortController.abort(new Error('Job wall time exceeded 300s'));
          this.safeCloseSocket(session.upstreamWs);
          if (session.currentShardId) {
            this.releaseShard(session.currentShardId);
          }
        }, jobRecord.durableReceipt ? Math.min(30000, this.config.jobMaxWallTimeMs) : this.config.jobMaxWallTimeMs);

        this.sessions.set(jobId, session);
        if (pendingGrant) {
          const grant = pendingGrant; this.executionGrants.set(jobId,grant); pendingGrant = undefined;
          grant.signal.addEventListener('abort',()=>{
            session.abortController.abort(); this.safeCloseSocket(session.upstreamWs);
            // Terminal CDC can settle/abort synchronously before the completion
            // handler releases the shard. Preserve confirmed recovery in either pool.
            if (session.currentShardId) { this.releaseShard(session.currentShardId,!!this.config.executionPolicy && this.jobsTable.get(jobId)?.status==='completed'); session.currentShardId=undefined; }
            this.jobQueue.markFailed(jobId,'execution_authorization_expired');
          },{once:true});
          if (grant.signal.aborted) this.jobQueue.markFailed(jobId,'execution_authorization_expired');
        }

        this.metrics.totalJobsSubmitted++;
        this.dispatchJobToUpstream(jobId);

        const streamUrl = `/v1/jobs/${jobId}/stream`;
        res.writeHead(202, {
          'Content-Type': 'application/json',
          'Location': streamUrl,
          'X-Nova-Job-Id': jobId,
          'X-Galx-Job-Id': jobId,
          'Operation-Location': `/v1/jobs/${jobId}`,
          'Retry-After': '2',
          ...this.getRateLimitHeaders(),
        });
        res.end(JSON.stringify({
          id: jobId,
          object: 'chat.completion.job',
          status: 'queued',
          model,
          streamUrl,
          isAttachedDuplicate: false,
          statusUrl: `/v1/jobs/${jobId}`,
          traceId: this.requestTraces.get(req),
          pollAfterMs: 2000,
          queuePosition: null,
          estimatedWaitSec: null,
          createdAt: Math.floor(jobRecord.createdAtMs / 1000),
        }));
      } catch (err: unknown) {
        await pendingGrant?.complete(null).catch(()=>{});
        if (res.writableEnded || res.destroyed) return;
        const failure = err instanceof RequestError ? err : new RequestError(500, 'internal_error', 'Relay could not process this request. Use the trace ID to investigate.');
        res.writeHead(failure.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: failure.message, code: failure.code } }));
      }
  }

  // --------------------------------------------------------------------------
  // LIVE WIRE IMAGE GENERATION & SYNTHESIS GATEWAY
  // --------------------------------------------------------------------------

  private async handleImageGenerations(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    tenantId: string
  ): Promise<void> {
    let grant: ExecutionGrant | undefined, completed = false, providerFailureObserved = false;
    try {
        const body = await readJsonBody(req, this.config.maxPayloadBytes, this.config.httpBodyTimeoutMs);
        if (this.config.executionPolicy) requestWorkload(this.config.executionPolicy.pool,req.url ?? '',body);
        if (this.isDraining) throw new RequestError(503, 'server_draining', 'Relay is restarting. Submit the request again after it is ready.');
        validateModelRequest(body, true);
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Missing required parameter: prompt', code: 'missing_prompt' } }));
          return;
        }

        const requestedModel = body.model || 'gpt-5.6-terra';
        const model = requestedModel;
        const imageCapability = `image:${requestedModel}`;

        const suppliedKey = req.headers['idempotency-key'] || body.idempotency_key;
        if (suppliedKey && (typeof suppliedKey !== 'string' || suppliedKey.length > 128)) throw new RequestError(400, 'invalid_request', 'Idempotency-Key must have at most 128 characters.');
        const keyed = suppliedKey ? this.imageReceipts.begin(tenantId, 'images', suppliedKey, { ...body, prompt }) : undefined;
        if (keyed?.existing) {
          const receipt = keyed.receipt;
          if (receipt.state === 'pending') {
            res.setHeader('Retry-After', '2');
            throw new RequestError(409, 'image_request_in_progress', 'Check the existing image request before submitting again.');
          }
          if (receipt.state === 'unknown') {
            res.setHeader('X-Should-Retry', 'false');
            throw new RequestError(409, 'image_outcome_unknown', 'The prior image outcome is unconfirmed. Do not repeat generation.');
          }
          if (!receipt.response) {
            res.setHeader('X-Should-Retry', 'false');
            throw new RequestError(409, 'result_not_retained', 'The image completed but is no longer available for replay.');
          }
          res.writeHead(receipt.response.status, { ...receipt.response.headers, 'X-Galx-Idempotency-Hit': 'true' });
          res.end(receipt.response.body);
          return;
        }

        this.updateCapabilityHealth();
        const authorizedAlias = this.config.executionPolicy?.pool === 'premium' && this.config.codexImageToolAlias && requestedModel === CODEX_IMAGE_ALIAS.requestedModel;
        if (!authorizedAlias && !this.capabilities.select(imageCapability)) {
          if (keyed) this.imageReceipts.forget(keyed.id);
          this.rejectModelCapacity(res, imageCapability); return;
        }

        const traceId = this.requestTraces.get(req);
        grant = await this.config.executionPolicy?.admit(req,body,tenantId,`image_${crypto.randomUUID()}`);
        grant?.assert();
        this.telemetry.model(traceId, requestedModel, model);
        this.metrics.totalImageJobsSubmitted++;

        let shardId: string;
        const controller = new AbortController();
        grant?.signal.addEventListener('abort',()=>controller.abort(),{once:true});
        this.imageControllers.add(controller);
        const deadline = setTimeout(() => controller.abort(new Error('image_wall_time_exceeded')), this.config.jobMaxWallTimeMs);
        const onClose = () => { if (!res.writableFinished) controller.abort(new Error('client_disconnect')); };
        res.once('close', onClose);
        try {
          const dispatched = await this.synthesizeImageWithFailover(prompt, body, model, traceId, controller.signal);
          const synthesisResult = dispatched.result;
          shardId = dispatched.shardId;
          if (res.destroyed || controller.signal.aborted) return;
          this.metrics.totalImageJobsCompleted++;
          completed = true;
          if (traceId) this.telemetry.finish(traceId, 'completed');

          const responseData = {
            created: Math.floor(Date.now() / 1000),
            data: [
              {
                b64_json: synthesisResult.b64_json,
                revised_prompt: synthesisResult.revised_prompt || prompt,
              },
            ],
            model: requestedModel,
            execution: dispatched.execution,
          };

          const responseHeaders = {
            'Content-Type': 'application/json',
            'X-Galx-Shard-Id': shardId,
            'X-Galx-Execution-Model': dispatched.execution.executionModel,
            'X-Galx-Routing-Mode': dispatched.execution.routingMode,
            ...this.getRateLimitHeaders(),
          };
          const responseBytes = Buffer.from(JSON.stringify(responseData));
          if (keyed) this.imageReceipts.complete(keyed.receipt, 200, responseHeaders, responseBytes);
          res.writeHead(200, responseHeaders);
          res.end(responseBytes);
        } catch (err: any) {
          this.metrics.totalImageJobsFailed++;
          providerFailureObserved = !controller.signal.aborted && err.providerFailureObserved === true;
          if (traceId) this.telemetry.finish(traceId, 'failed', controller.signal.aborted ? String(controller.signal.reason?.message || 'image_wall_time_exceeded') : err.telemetryReason || err.message);
          if (res.destroyed || res.writableEnded) return;
          if (err.preGenerationTargetRejection === true) {
            if (this.config.executionPolicy) {
              res.setHeader(PRIVATE_RELAY_FAILURE_HEADER, encodePrivateRelayFailure({
                version: 'v1', class: 'pre_generation_rejected', scope: 'worker',
                ...(Number.isFinite(err.preGenerationRetryAfterMs) ? { retryAfterMs: err.preGenerationRetryAfterMs } : {}),
              }));
            }
            res.writeHead(502, { 'Content-Type': 'application/json', 'X-Should-Retry': 'false' });
            res.end(JSON.stringify({ error: {
              execution_state: 'unknown',
              message: 'Image generation failed. Inspect the trace for provider, connection or deadline evidence.',
              code: 'upstream_image_synthesis_failed',
            } }));
            return;
          }
          if (err.message === 'all_shards_unavailable') {
            const retryAfter = this.fleetRetryAfter(true);
            if (this.config.executionPolicy) res.setHeader(PRIVATE_RELAY_FAILURE_HEADER, encodePrivateRelayFailure(fleetRelayFailure(retryAfter === null ? undefined : retryAfter * 1000)));
            this.rejectUnavailableFleet(res, true); return;
          }
          // The pool consumes this fixed, private signal for worker-aware
          // routing. It is never emitted by standalone/public relay modes.
          if (this.config.executionPolicy) res.setHeader(PRIVATE_RELAY_FAILURE_HEADER, encodePrivateRelayFailure(classifyImageRelayFailure(err)));
          res.writeHead(502, { 'Content-Type': 'application/json', 'X-Should-Retry': 'false' });
          res.end(JSON.stringify({
            error: {
              execution_state: 'unknown',
              message: 'Image generation failed. Inspect the trace for provider, connection or deadline evidence.',
              code: 'upstream_image_synthesis_failed',
            },
          }));
        } finally {
          clearTimeout(deadline);
          res.off('close', onClose);
          this.imageControllers.delete(controller);
          if (keyed?.receipt.state === 'pending') keyed.receipt.state = 'unknown';
        }
      } catch (err: unknown) {
        if (res.writableEnded || res.destroyed) return;
        const failure = err instanceof RequestError ? err : new RequestError(500, 'internal_error', 'Relay could not process this request. Use the trace ID to investigate.');
        res.writeHead(failure.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: failure.message, code: failure.code } }));
      } finally { await grant?.complete(completed ? true : providerFailureObserved ? false : null).catch(()=>{}); }
  }

  private async synthesizeImageWithFailover(prompt: string, body: Record<string, unknown>, model: string, traceId?: string, signal: AbortSignal = AbortSignal.timeout(this.config.jobMaxWallTimeMs)) {
    const authorizedAlias = this.config.executionPolicy?.pool === 'premium' && this.config.codexImageToolAlias && model === CODEX_IMAGE_ALIAS.requestedModel;
    const imageModel = `image:${body.model || model}`;
    const attemptedShardIds = new Set<string>();
    let lastPreGenerationFailure: { retryAfterMs?: number } | undefined;

    for (;;) {
      signal.throwIfAborted();
      await this.refreshShardRegistry();
      signal.throwIfAborted();
      const shard = this.acquireHealthyShard(attemptedShardIds, imageModel, authorizedAlias);
      if (!shard) {
        if (this.config.assignedShardId && lastPreGenerationFailure) {
          throw Object.assign(new Error('pre_generation_target_rejected'), {
            preGenerationTargetRejection: true,
            preGenerationRetryAfterMs: lastPreGenerationFailure.retryAfterMs,
          });
        }
        throw new Error('all_shards_unavailable');
      }
      attemptedShardIds.add(shard.id);

      const capabilityTicket = this.capabilities.beginObservation(shard.id, imageModel);
      const execution = imageExecution(model, shard.accessToken.startsWith('sk-'), this.config.codexImageToolAlias);
      const alias = execution.routingMode === 'codex_image_tool_alias';
      this.telemetry.attempt(traceId, shard.id, shard.accessToken.startsWith('sk-') || alias ? 'http' : 'websocket');
      this.telemetry.model(traceId, model, execution.executionModel);
      try {
        const result = shard.accessToken.startsWith('sk-')
          ? await this.synthesizeImageViaOpenAiRest(prompt, body, shard.accessToken, signal)
          : alias ? await generateCodexToolImage(prompt, shard, signal, this.config.maxImagePayloadBytes)
          : await this.synthesizeImageViaCodex(prompt, execution.executionModel, shard, traceId, signal);
        if (capabilityTicket) this.capabilities.observe(capabilityTicket, imageModel, 'AVAILABLE', undefined, execution.routingMode === 'codex_image_tool_alias');
        this.releaseShard(shard.id, true, true);
        return { result, shardId: shard.id, execution };
      } catch (error: any) {
        if (signal.aborted) { this.releaseShard(shard.id, false, true); throw signal.reason; }
        const negative = classifyCapabilityFailure(imageFailureFrame(error));
        if (negative && capabilityTicket) this.capabilities.observe(capabilityTicket, imageModel, negative.state, negative.reason, alias);
        const failure = classifyUpstreamError(imageFailureFrame(error));
        // Only an actual provider response can change account failure history.
        error.providerFailureObserved = Boolean(error.upstream) && (failure.quota || failure.unauthorized || failure.retryable);
        error.telemetryReason = error.upstream ? `upstream_error_${failure.code}` : error.message;
        this.telemetry.failedAttempt(traceId, error.telemetryReason);
        const safeFailover = isConfirmedPreGenerationImageFailure(error, failure);
        if (failure.quota) this.recordQuotaFailure(shard.id, failure.deadline, true, undefined, true);
        else if (error.providerFailureObserved) this.recordShardFailure(shard.id, failure.unauthorized, true);
        else this.releaseShard(shard.id, false, true);

        // This is target failover, not a generic request retry. The same
        // request identity remains in one receipt while each shard is tried
        // at most once. Any ambiguous outcome stays terminal.
        if (safeFailover) {
          const retryAfterMs = failure.deadline === undefined ? undefined : Math.max(1000, failure.deadline - Date.now());
          lastPreGenerationFailure = { ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
          continue;
        }
        lastPreGenerationFailure = undefined;
        throw error;
      }
    }
  }

  private synthesizeImageViaCodex(
    prompt: string,
    model: string,
    shard: ShardRecord,
    traceId?: string,
    signal?: AbortSignal
  ): Promise<{ b64_json: string; revised_prompt?: string }> {
    return new Promise((resolve, reject) => {
      const WebSocketClass = WebSocket;
      if (!WebSocketClass) {
        return reject(new Error('WebSocket runtime is missing in environment'));
      }

      const wsHeaders: Record<string, string> = {
        Authorization: `Bearer ${shard.accessToken}`,
        'User-Agent': 'Codex-CLI/0.150.1 (darwin; arm64)',
        'X-Codex-Originator': 'codex_cli',
        'OpenAI-Beta': 'responses_websockets=2026-02-06',
        'X-OpenAI-Product-Sku': 'codex',
        'ChatGPT-Account-Id': shard.accountId,
      };

      let ws: any;
      let settled = false;
      let pingInterval: NodeJS.Timeout | null = null;
      let watchdogTimer: NodeJS.Timeout | null = null;

      let b64Result = '';
      let revisedPrompt = '';

      const onAbort = () => finishError(signal?.reason || new Error('image_cancelled'));
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        if (watchdogTimer) {
          clearTimeout(watchdogTimer);
          watchdogTimer = null;
        }
        if (ws) {
          this.safeCloseSocket(ws, 1000, 'Image synthesis complete');
        }
      };

      const finishSuccess = (b64: string, revised?: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ b64_json: b64, revised_prompt: revised });
      };

      const finishError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });

      // Watchdog timeout (90s ceiling for neural visual synthesis)
      watchdogTimer = setTimeout(() => {
        finishError(new Error('Upstream visual synthesis timed out after 90s'));
      }, 90_000);

      try {
        ws = new WebSocketClass(this.config.wsEndpoint, { headers: wsHeaders, maxPayload: this.config.maxImagePayloadBytes, followRedirects: false });
        ws.on('unexpected-response', (_request: unknown, response: http.IncomingMessage) => {
          response.resume();
          finishError(Object.assign(new Error(`Upstream HTTP ${response.statusCode}`), {
            upstream: { status: response.statusCode, headers: { 'retry-after': response.headers['retry-after'] } },
          }));
        });
        this.tuneSocket(ws);
      } catch (err: any) {
        return finishError(err);
      }

      ws.onopen = () => {
        this.telemetry.phase(traceId, 'Generate image (includes network)', 'provider');
        pingInterval = setInterval(() => {
          try {
            if (typeof ws.ping === 'function') {
              ws.ping();
            }
          } catch {}
        }, 15_000);

        const initPayload = {
          type: 'response.create',
          model: model || 'gpt-5.6-terra',
          stream: true,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: prompt,
                },
              ],
            },
          ],
          tools: [
            {
              type: 'image_generation',
            },
          ],
        };

        try {
          ws.send(JSON.stringify(initPayload));
        } catch (err: any) {
          finishError(new Error(`Failed to send initial image request frame: ${err.message}`));
        }
      };

      ws.onmessage = (event: any) => {
        try {
          const raw = typeof event.data === 'string' ? event.data : event.data?.toString?.('utf-8');
          if (!raw) return;
          const frame = JSON.parse(raw);

          // Capture image result from completed image_generation_call output item
          if (frame.type === 'response.output_item.done' && frame.item?.type === 'image_generation_call') {
            if (frame.item.result) {
              b64Result = frame.item.result;
            }
            if (frame.item.revised_prompt) {
              revisedPrompt = frame.item.revised_prompt;
            }
          }

          if (frame.type === 'response.completed' || frame.type === 'response.done') {
            if (b64Result) {
              finishSuccess(b64Result, revisedPrompt);
            } else {
              finishError(new Error('Codex completed stream without returning image data'));
            }
          }

          if (frame.type === 'error' || (frame.type === 'response.failed' && frame.response?.error)) {
            const errorMsg = frame.error?.message || frame.response?.error?.message || JSON.stringify(frame);
            finishError(Object.assign(new Error(`Codex WebSocket error: ${errorMsg}`), { upstream: frame }));
          }
        } catch (err: any) {
          // Ignore partial non-JSON frames
        }
      };

      ws.onerror = (err: any) => {
        finishError(new Error(`Codex WebSocket transport error: ${err.message || 'connection failed'}`));
      };

      ws.onclose = (event: any) => {
        if (!settled) {
          if (b64Result) {
            finishSuccess(b64Result, revisedPrompt);
          } else {
            finishError(new Error(`Codex WebSocket closed prematurely (code: ${event?.code || 1006}, reason: ${event?.reason || 'none'})`));
          }
        }
      };
    });
  }

  private async synthesizeImageViaOpenAiRest(
    prompt: string,
    body: Record<string, unknown>,
    apiKey: string,
    signal: AbortSignal = AbortSignal.timeout(this.config.jobMaxWallTimeMs)
  ): Promise<{ b64_json: string; revised_prompt?: string }> {
    const resp = await fetch('https://api.openai.com/v1/images/generations', {
      signal,
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        prompt,
        model: body.model || 'gpt-image-2',
        size: body.size || '1024x1024',
        quality: body.quality || 'standard',
        n: 1,
        response_format: 'b64_json',
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw Object.assign(new Error(`OpenAI REST returned ${resp.status}: ${errText}`), { upstream: { status: resp.status, headers: { 'retry-after': resp.headers.get('retry-after') } } });
    }

    const data = await resp.json() as any;
    const item = data.data?.[0];
    if (!item?.b64_json) {
      throw new Error('OpenAI REST response did not contain b64_json');
    }

    return {
      b64_json: item.b64_json,
      revised_prompt: item.revised_prompt,
    };
  }

  // --------------------------------------------------------------------------
  // RESUMABLE SSE STREAM BUS (W3C Last-Event-ID + BroccoliDB Replay)
  // --------------------------------------------------------------------------

  private handleJobStream(
    jobId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    query: Record<string, string | string[] | undefined>
  ): void {
    const job = this.jobsTable.get(jobId);
    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Job ${jobId} not found`, code: 'job_not_found' } }));
      return;
    }

    const session = this.sessions.get(jobId);

    const lastEventIdHeader = req.headers['last-event-id'];
    const cursor = lastEventIdHeader ?? query['last_event_id'] ?? '0';
    const lastSeqNo = Number(cursor);
    if (typeof cursor !== 'string' || !/^\d+$/.test(cursor) || !Number.isSafeInteger(lastSeqNo) || lastSeqNo > job.seqCounter) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'invalid_replay_cursor', message: 'Last-Event-ID must be a nonnegative sequence number already emitted by this job.' } }));
      return;
    }
    const firstRetained = this.tokensTable.query({ where: { jobId }, sortBy: 'seqNo', sortOrder: 'asc', limit: 1 })[0];
    if (lastSeqNo < job.seqCounter && (!firstRetained || lastSeqNo < firstRetained.seqNo - 1)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'replay_window_expired', message: 'Earlier output is no longer retained. Start a new request; replaying this cursor would omit output.' } }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Galx-Transport': 'broccolidb-resumable-sse-bus',
    });

    let unsubscribe: () => void;
    try {
      unsubscribe = this.jobBus.subscribe(jobId, res);
    } catch {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'job_subscriber_limit_exceeded' })}\n\n`);
      res.end();
      return;
    }
    if (job.isDetached && session?.graceTimer) {
      clearTimeout(session.graceTimer);
      session.graceTimer = undefined;
      this.jobQueue.setDetached(jobId, false);
      this.metrics.totalGraceReconnectionsWon++;
      this.metrics.totalReconnections++;
    }

    this.jobBus.replay(jobId, res, lastSeqNo, () => this.metrics.totalTokensServedFromBuffer++);

    if (job.status === 'completed') {
      this.jobBus.sendToSubscriber(jobId, res, completionFrame(job) + 'data: [DONE]\n\n', true);
      return;
    }
    if (job.status === 'failed') {
      this.jobBus.sendToSubscriber(
        jobId,
        res,
        `event: error\ndata: ${JSON.stringify({ error: job.error || job.status, execution_state: job.continuationAllowed === true ? 'failed' : 'unknown' })}\n\n`,
        true,
      );
      return;
    }
    if (job.status === 'cancelled') {
      this.jobBus.sendToSubscriber(
        jobId,
        res,
        `event: cancelled\ndata: ${JSON.stringify({ status: 'cancelled', reason: job.error })}\n\n`,
        true,
      );
      return;
    }

    // Edge Keepalive Heartbeats (: ping\n\n) to defeat Cloudflare 100s idle drops
    const keepaliveTimer = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(keepaliveTimer);
        return;
      }
      this.jobBus.sendToSubscriber(jobId, res, ': ping\n\n');
    }, this.config.sseKeepaliveIntervalMs);

    // Two-Tier Disconnect Protocol: 15s Grace Window for dirty drops
    req.on('close', () => {
      clearInterval(keepaliveTimer);
      unsubscribe();
      if (session) {
        if (this.jobBus.subscriberCount(jobId) === 0) {
          const latestJob = this.jobsTable.get(jobId);
          if (latestJob && (latestJob.status === 'running' || latestJob.status === 'streaming')) {
            this.jobQueue.setDetached(jobId, true);
            this.metrics.totalGracePeriodsEntered++;

            session.graceTimer = setTimeout(() => {
              const currentJob = this.jobsTable.get(jobId);
              if (currentJob && currentJob.isDetached && this.jobBus.subscriberCount(jobId) === 0) {
                // Hard Abort on Grace Window Expiry (Anti-Zombie Leash)
                this.metrics.totalZombieLeashAborts++;
                if (this.jobQueue.markCancelled(jobId, 'client_disconnect_grace_expired')) {
                  this.metrics.totalJobsCancelled++;
                }
                session.abortController.abort(new Error('Client disconnect grace window expired'));
                this.safeCloseSocket(session.upstreamWs);
                if (session.currentShardId) {
                  this.releaseShard(session.currentShardId);
                  session.currentShardId = undefined;
                }
              }
            }, this.config.clientDisconnectGraceMs);
          }
        }
      }
    });
  }

  // --------------------------------------------------------------------------
  // UPSTREAM CODEX WEBSOCKET CLIENT & 7-LAYER TIMEOUT CONTROLLER
  // --------------------------------------------------------------------------

  private async dispatchJobToUpstream(jobId: string): Promise<void> {
    const session = this.sessions.get(jobId);
    if (!session) return;
    if (session.abortController.signal.aborted) return;
    const queuedJob = this.jobsTable.get(jobId);
    if (!queuedJob) return;
    try { if (this.config.executionPolicy) { const grant = this.executionGrants.get(jobId); if (!grant) throw Error(); grant.assert(); } }
    catch { this.jobQueue.markFailed(jobId,'execution_authorization_expired'); return; }

    try { await this.refreshShardRegistry(); } catch {
      if (this.jobQueue.markFailed(jobId, 'shard_registry_unavailable')) this.metrics.totalJobsFailed++;
      return;
    }
    if (session.abortController.signal.aborted || this.sessions.get(jobId) !== session) return;
    // Acquire healthy shard (exclude every previously attempted account)
    const shard = this.acquireHealthyShard(session.attemptedShardIds, queuedJob.model, false, queuedJob.id);
    if (!shard) {
      if (this.jobQueue.markFailed(jobId, 'all_shards_exhausted')) this.metrics.totalJobsFailed++;
      return;
    }

    session.currentShardId = shard.id;
    session.attemptedShardIds.add(shard.id);
    session.lastSeenAliveMs = Date.now();
    const job = this.jobQueue.acquireForDispatch(jobId, shard.id, session.retryCount);
    if (!job) {
      this.releaseShard(shard.id);
      return;
    }
    if (job.durableReceipt) {
      try { this.receiptStore().dispatch(job.id, job.tenantId); }
      catch { this.jobQueue.markFailed(job.id, 'receipt_dispatch_unavailable'); this.releaseShard(shard.id); session.currentShardId = undefined; return; }
    }
    const attempt: TransportAttempt = {
      id: ++session.activeAttemptId,
      shardId: shard.id,
      hasReceivedFirstToken: false,
      heartbeatPending: false,
      completionObserved: false,
      isFirstChunkAfterFailover: false,
    };

    await this._openUpstreamTransport(job, shard, attempt);
  }

  private async _openUpstreamTransport(
    job: JobRecord,
    shard: ShardRecord,
    attempt: TransportAttempt,
  ): Promise<void> {
    const session = this.sessions.get(job.id);
    if (!session || session.abortController.signal.aborted || session.activeAttemptId !== attempt.id) return;
    try { if (this.config.executionPolicy) this.executionGrants.get(job.id)!.assert(); }
    catch { this.jobQueue.markFailed(job.id,'execution_authorization_expired'); return; }

    const capabilityTicket = this.capabilities.beginObservation(shard.id, job.model);
    this.telemetry.attempt(job.id, shard.id);
    const WebSocketClass = WebSocket;
    if (!WebSocketClass) {
      if (session.downstreamFailoverKeepaliveTimer) {
        clearInterval(session.downstreamFailoverKeepaliveTimer);
        session.downstreamFailoverKeepaliveTimer = undefined;
      }
      this.jobBus.publish({
        type: 'job:transport_drop',
        jobId: job.id,
        attemptId: attempt.id,
        shardId: shard.id,
        reason: 'websocket_runtime_missing',
      });
      return;
    }

    const { input: inputList, instructions } = functionInput(JSON.parse(job.messagesJson || '[]'));

    const wsHeaders: Record<string, string> = {
      Authorization: `Bearer ${shard.accessToken}`,
      'User-Agent': 'Codex-CLI/0.150.1 (darwin; arm64)',
      'X-Codex-Originator': 'codex_cli',
      'OpenAI-Beta': 'responses_websockets=2026-02-06',
      'X-OpenAI-Product-Sku': 'codex',
      'ChatGPT-Account-Id': shard.accountId,
    };

    const cleanupTimers = () => {
      if (session.connectTimer) clearTimeout(session.connectTimer);
      if (session.ttftTimer) clearTimeout(session.ttftTimer);
      if (session.intraChunkTimer) clearTimeout(session.intraChunkTimer);
      if (session.wsPingTimer) clearInterval(session.wsPingTimer);
      if (session.heartbeatAckTimeoutTimer) clearTimeout(session.heartbeatAckTimeoutTimer);
      if (session.downstreamFailoverKeepaliveTimer) {
        clearInterval(session.downstreamFailoverKeepaliveTimer);
        session.downstreamFailoverKeepaliveTimer = undefined;
      }
    };

    // Calculate Adaptive TTFT ceiling based on reasoning effort and model
    const calculateTtftCeiling = (): number => {
      let base = this.config.wsTtftTimeoutMs;
      const effort = job.reasoningEffort?.toLowerCase() || '';
      const model = job.model?.toLowerCase() || '';
      if (effort === 'high' || model.includes('o3') || model.includes('deep') || model.includes('sol')) {
        return Math.max(base * this.config.deepReasoningTtftMultiplier, 120_000);
      }
      if (effort === 'low') {
        return Math.min(base, 30_000);
      }
      return base; // 60,000ms
    };

    session.activeTtftDeadlineMs = calculateTtftCeiling();

    // Transport failure publication. Retry and terminal policy runs from the
    // bus consumer after this WebSocket callback has returned.
    let failoverTriggered = false;
    const triggerFailover = (reason: string, isQuotaError = false, closeCode = 1006, retryAtMs?: number, unauthorized = false, retryable = true, providerFailureObserved = false) => {
      if (failoverTriggered) return;
      failoverTriggered = true;

      cleanupTimers();
      this.safeCloseSocket(ws, closeCode, `Failover: ${reason}`);
      this.jobBus.publish({
        type: 'job:transport_drop',
        jobId: job.id,
        attemptId: attempt.id,
        shardId: shard.id,
        reason,
        isQuotaError, retryAtMs, unauthorized, retryable, providerFailureObserved,
      });
    };

    // Layer 0: WebSocket Handshake Timeout (15s)
    session.connectTimer = setTimeout(() => {
      triggerFailover('ws_connect_handshake_timeout');
    }, this.config.wsConnectTimeoutMs);

    let ws: any;
    try {
      ws = new WebSocketClass(this.config.wsEndpoint, { headers: wsHeaders, maxPayload: this.config.maxPayloadBytes, followRedirects: false });
      session.upstreamWs = ws;
      ws.on('unexpected-response', (_request: unknown, response: http.IncomingMessage) => {
        response.resume();
        try { this.config.onUpstreamDiagnostic?.(upstreamDiagnostic({ status: response.statusCode }), { jobId: job.id }); } catch { /* Diagnostics never affect execution. */ }
        triggerFailover(`upstream_http_${response.statusCode}`, response.statusCode === 429, 1006,
          retryDeadline(response.headers['retry-after']), response.statusCode === 401, ![400, 404, 405, 413, 422].includes(response.statusCode || 0),
          response.statusCode === 401 || response.statusCode === 429 || Number(response.statusCode) >= 500);
      });
      this.tuneSocket(ws);
    } catch (err: any) {
      triggerFailover(`ws_init_error: ${err.message}`);
      return;
    }

    const refreshChunkTimer = () => {
      if (session.intraChunkTimer) clearTimeout(session.intraChunkTimer);
      session.intraChunkTimer = setTimeout(() => {
        triggerFailover('intra_chunk_silence_timeout');
      }, this.config.wsIntraChunkTimeoutMs);
    };

    const resetTtftTimer = (durationMs: number) => {
      if (session.ttftTimer) clearTimeout(session.ttftTimer);
      session.ttftTimer = setTimeout(() => {
        this.metrics.totalTtftDeadlocks++;
        triggerFailover('ttft_deadlock_timeout');
      }, durationMs);
    };

    ws.onopen = () => {
      if (session.activeAttemptId !== attempt.id) {
        this.safeCloseSocket(ws, 1000, 'Superseded transport attempt');
        return;
      }
      if (session.connectTimer) clearTimeout(session.connectTimer);
      this.tuneSocket(ws);
      session.lastSeenAliveMs = Date.now();
      this.telemetry.phase(job.id, 'Wait for first output', 'provider');
      attempt.heartbeatPending = false;

      // Handle RFC 6455 protocol-level pongs from Node.js 'ws'
      if (typeof (ws as any).on === 'function') {
        (ws as any).on('pong', () => {
          attempt.heartbeatPending = false;
          session.lastSeenAliveMs = Date.now();
          if (session.heartbeatAckTimeoutTimer) {
            clearTimeout(session.heartbeatAckTimeoutTimer);
            session.heartbeatAckTimeoutTimer = undefined;
          }
        });
      }

      // Layer 1: Adaptive TTFT Deadlock Timer (Calibrated by Reasoning Effort)
      resetTtftTimer(session.activeTtftDeadlineMs);

      // Layer 5: Discord Gateway Heartbeat ACK (OP 1 / OP 11) Protocol
      const jitterMs = Math.floor(Math.random() * 3000);
      session.wsPingTimer = setInterval(() => {
        if (session.abortController.signal.aborted || failoverTriggered) return;

        // Discord Heartbeat ACK Verification: If previous heartbeat was NOT acked, verify actual silence
        if (attempt.heartbeatPending) {
          const timeSinceLastActivity = Date.now() - session.lastSeenAliveMs;
          if (timeSinceLastActivity < this.config.wsIntraChunkTimeoutMs) {
            attempt.heartbeatPending = false;
          } else {
            this.metrics.totalHeartbeatAckMisses++;
            this.metrics.totalDeadPeerRecoveries++;
            console.warn(`[AntiFragileRelay] Shard ${shard.id} Heartbeat ACK Miss (zombie peer detected). Evicting with code 4000...`);
            triggerFailover('discord_heartbeat_ack_miss', false, 4000);
            return;
          }
        }

        // Arm pending heartbeat ACK flag
        attempt.heartbeatPending = true;

        try {
          if (typeof ws.ping === 'function') {
            ws.ping();
          } else if (typeof ws.send === 'function') {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        } catch {
          triggerFailover('ws_ping_send_error');
          return;
        }

        // Pong ACK Deadline Watchdog (Only evict if genuinely silent)
        session.heartbeatAckTimeoutTimer = setTimeout(() => {
          if (session.abortController.signal.aborted || failoverTriggered) return;
          if (attempt.heartbeatPending) {
            const timeSinceLastActivity = Date.now() - session.lastSeenAliveMs;
            if (timeSinceLastActivity < this.config.wsIntraChunkTimeoutMs) {
              attempt.heartbeatPending = false;
              return;
            }
            this.metrics.totalDeadPeerRecoveries++;
            console.warn(`[AntiFragileRelay] Shard ${shard.id} pong deadline expired (${this.config.wsDeadPeerPongTimeoutMs}ms); evicting dead peer.`);
            triggerFailover('dead_peer_pong_timeout', false, 4000);
          }
        }, this.config.wsDeadPeerPongTimeoutMs);
      }, this.config.wsDeadPeerPingIntervalMs + jitterMs);

      const createPayload: Record<string, any> = {
        type: 'response.create',
        model: job.model,
        input: inputList,
        stream: true,
      };
      if (instructions) createPayload.instructions = instructions;
      if (job.functionContract?.tools.length) {
        createPayload.tools = job.functionContract.tools;
        createPayload.tool_choice = job.functionContract.toolChoice;
        if (job.functionContract.parallelToolCalls !== undefined) createPayload.parallel_tool_calls = job.functionContract.parallelToolCalls;
      }
      // Only qualified transports receive this provider parameter. Other
      // isolated text uses its conservative local observed-output budget.
      if (this.config.forwardOutputTokenLimit && (job.durableReceipt || this.config.executionPolicy) && job.maxOutputTokens !== undefined) createPayload.max_output_tokens = job.maxOutputTokens;
      if (job.reasoningEffort) {
        createPayload.reasoning = { effort: job.reasoningEffort };
      }

      try {
        ws.send(JSON.stringify(createPayload));
      } catch (err: any) {
        triggerFailover(`ws_send_payload_error: ${err.message}`);
      }
    };

    ws.onmessage = (event: any) => {
      try {
        if (session.activeAttemptId !== attempt.id || session.abortController.signal.aborted || failoverTriggered) return;
        session.lastSeenAliveMs = Date.now();
        // Clear pending heartbeat on ANY frame arrival from upstream
        attempt.heartbeatPending = false;
        if (session.heartbeatAckTimeoutTimer) {
          clearTimeout(session.heartbeatAckTimeoutTimer);
          session.heartbeatAckTimeoutTimer = undefined;
        }
        // Stop downstream failover keepalive ticker if running
        if (session.downstreamFailoverKeepaliveTimer) {
          clearInterval(session.downstreamFailoverKeepaliveTimer);
          session.downstreamFailoverKeepaliveTimer = undefined;
        }

        const raw = typeof event.data === 'string' ? event.data : event.data.toString();
        const data = JSON.parse(raw);

        // Ping / Pong Protocol
        if (data.type === 'ping') {
          try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
          return;
        }
        if (data.type === 'pong' || data.type === 'response.pong') {
          attempt.heartbeatPending = false;
          session.lastSeenAliveMs = Date.now();
          if (session.heartbeatAckTimeoutTimer) {
            clearTimeout(session.heartbeatAckTimeoutTimer);
            session.heartbeatAckTimeoutTimer = undefined;
          }
          return;
        }

        // Dynamic Reasoning / Thinking Delta Handling
        if (data.type === 'response.reasoning.delta' || data.type === 'response.reasoning_text.delta' ||
            data.type === 'response.reasoning_summary_text.delta') {
          if (typeof data.delta === 'string' && session.outputBudget && !session.outputBudget.observe(data.delta)) {
            this.stopForOutputBudget(job.id); return;
          }
          this.metrics.totalReasoningChunksReceived++;
          // Active thinking in progress -> extend TTFT deadlock timer dynamically
          if (!attempt.hasReceivedFirstToken) {
            resetTtftTimer(this.config.reasoningActivityExtensionMs);
          }
          refreshChunkTimer();

          if (data.delta) {
            this.jobBus.publish({ type: 'job:reasoning', jobId: job.id, text: String(data.delta) });
          }
          return;
        }

        // Proactive Rate-Limit Handling via OpenAI Responses Wire Frames
        if (data.type === 'rate_limits.updated' && Array.isArray(data.rate_limits)) {
          const limits = parseProviderLimits(data.rate_limits);
          const current = this.shardsTable.get(shard.id);
          if (current) this.persistShard({ ...current, providerLimits: limits });
          const exhausted = limits.filter(l => l.remaining === 0);
          if (exhausted.length) {
            this.metrics.totalProactiveRateLimitCooldowns++;
            this.recordQuotaFailure(shard.id, Math.max(...exhausted.map(l => l.resetAtMs ?? 0)), false, job.id);
          }
          return;
        }

        // Progress / Keepalive Events
        if (data.type === 'response.in_progress' || data.type === 'response.output_item.added' || data.type === 'response.created') {
          if (!attempt.hasReceivedFirstToken) {
            resetTtftTimer(this.config.reasoningActivityExtensionMs);
          }
          return;
        }

        // Tool arguments are executable data. Publish complete validated calls only
        // after terminal success, never partial argument text or approval frames.
        if (data.type === 'response.function_call_arguments.delta' || data.type === 'response.function_call_arguments.done') {
          if (data.type === 'response.function_call_arguments.delta' && typeof data.delta === 'string' &&
              session.outputBudget && !session.outputBudget.observe(data.delta, true)) {
            this.stopForOutputBudget(job.id); return;
          }
          if (!attempt.hasReceivedFirstToken) resetTtftTimer(this.config.reasoningActivityExtensionMs);
          refreshChunkTimer();
          return;
        }
        const isOutputDelta = data.type === 'response.output_text.delta' || data.type === 'response.audio.delta';

        if (isOutputDelta && data.delta) {
          let chunkText = typeof data.delta === 'string' ? data.delta : (data.delta.text || '');
          if (session.outputBudget && !session.outputBudget.observe(chunkText)) { this.stopForOutputBudget(job.id); return; }

          // Figma / Liveblocks Suffix-Prefix Overlap Reconciliation
          if (attempt.isFirstChunkAfterFailover && attempt.priorFailoverSuffix) {
            const originalLength = chunkText.length;
            chunkText = reconcileOverlap(attempt.priorFailoverSuffix, chunkText, this.config.deDuplicationOverlapWindowChars);
            attempt.isFirstChunkAfterFailover = false;
            attempt.priorFailoverSuffix = undefined;

            if (chunkText.length < originalLength) {
              this.metrics.totalOverlapReconciliationsWon++;
              console.log(`[AntiFragileRelay] Overlap reconciliation won: trimmed ${originalLength - chunkText.length} duplicate characters.`);
            }

            if (!chunkText || chunkText.length === 0) {
              // Pure duplicate echo chunk; wait for next non-duplicate chunk
              return;
            }
            data.delta = chunkText;
          }

          const now = Date.now();

          if (!attempt.hasReceivedFirstToken) {
            attempt.hasReceivedFirstToken = true;
            if (session.ttftTimer) clearTimeout(session.ttftTimer);
          }

          // Layer 2: Inter-Token Latency (ITL) Watchdog
          if (session.lastChunkAtMs > 0) {
            const itlGap = now - session.lastChunkAtMs;
            session.ewmaItlMs = session.ewmaItlMs === 0 ? itlGap : 0.15 * itlGap + 0.85 * session.ewmaItlMs;

            if (itlGap > this.config.itlGapThresholdMs) {
              session.consecutiveItlStalls++;
              this.metrics.totalItlStallsDetected++;
              if (session.consecutiveItlStalls >= this.config.itlConsecutiveLimit) {
                console.warn(`[AntiFragileRelay] Job ${job.id}: 3 consecutive ITL stall violations. Triggering handover...`);
                triggerFailover('consecutive_itl_stalls_exceeded');
                return;
              }
            } else {
              session.consecutiveItlStalls = 0;
            }
          }
          session.lastChunkAtMs = now;

          // Layer 3: Reset Intra-Chunk Timer
          refreshChunkTimer();

          // The socket reports an observation only. Sequence allocation and
          // relay-job projection happen asynchronously after this callback.
          this.jobBus.publish({
            type: 'job:transport_token',
            jobId: job.id,
            attemptId: attempt.id,
            shardId: shard.id,
            text: chunkText,
            timestampMs: now,
          });
          return;
        }

        // Completion Arrival (response.completed or response.done)
        if ((data.type === 'response.completed' || data.type === 'response.done') && data.response?.status !== 'failed') {
          if (capabilityTicket) this.capabilities.observe(capabilityTicket, job.model, 'AVAILABLE');
          attempt.completionObserved = true;
          cleanupTimers();
          if (session.wallTimer) clearTimeout(session.wallTimer);
          this.jobBus.publish({
            type: 'job:transport_completed',
            jobId: job.id,
            attemptId: attempt.id,
            shardId: shard.id,
            response: data.response,
          });
          return;
        }

        // Upstream Error Frame (429 Rate Limit / 5xx Overloaded)
        if (data.type === 'error' || data.type === 'response.failed' || data.response?.status === 'failed') {
          try { this.config.onUpstreamDiagnostic?.(upstreamDiagnostic(data), { jobId: job.id }); } catch { /* Observability cannot change retry/settlement policy. */ }
          const negative = classifyCapabilityFailure(data);
          if (negative && capabilityTicket) this.capabilities.observe(capabilityTicket, job.model, negative.state, negative.reason);
          const failure = classifyUpstreamError(data);
          triggerFailover(`upstream_error_${failure.code}`, failure.quota, 1006, failure.deadline, failure.unauthorized, failure.retryable,
            failure.quota || failure.unauthorized || failure.retryable);
          return;
        }
      } catch (err: any) {
        console.error('[BroccoliDB Relay] Error parsing WebSocket frame:', err.message);
      }
    };

    ws.onerror = (err: any) => {
      if (session.activeAttemptId !== attempt.id) return;
      triggerFailover(`ws_socket_error: ${err.message || 'unknown'}`);
    };

    ws.onclose = (event: any) => {
      if (session.activeAttemptId !== attempt.id || failoverTriggered) return;
      if (attempt.completionObserved) {
        cleanupTimers();
        return;
      }
      const currentJob = this.jobsTable.get(job.id);
      if (
        currentJob &&
        currentJob.status !== 'completed' &&
        currentJob.status !== 'cancelled' &&
        currentJob.status !== 'failed'
      ) {
        const isQuota = event?.code === 4029 || /quota|rate.?limit/.test(event?.reason || '');
        triggerFailover(`ws_abnormal_closure_${event?.code || 'unknown'}`, isQuota);
      } else {
        cleanupTimers();
        this.releaseShard(shard.id);
      }
    };
  }

  // --------------------------------------------------------------------------
  // ANTI-FRAGILE MID-STREAM SHARD FAILOVER & CONTEXT CONTINUATION
  // --------------------------------------------------------------------------

  private stopForOutputBudget(jobId: string): void {
    const session = this.sessions.get(jobId);
    if (!session || !this.jobQueue.markFailed(jobId, 'output_limit_exceeded')) return;
    this.metrics.totalJobsFailed++;
    session.abortController.abort(); this.safeCloseSocket(session.upstreamWs);
    if (session.currentShardId) { this.releaseShard(session.currentShardId); session.currentShardId = undefined; }
  }

  private handleTransportToken(event: JobBusEventOf<'job:transport_token'>): void {
    const session = this.sessions.get(event.jobId);
    if (!session || session.abortController.signal.aborted || session.activeAttemptId !== event.attemptId) return;
    const allocation = this.jobQueue.recordToken(event.jobId);
    if (!allocation) return;
    if (this.jobsTable.get(event.jobId)?.durableReceipt) {
      const text = (session.receiptText ?? '') + event.text;
      if (Buffer.byteLength(text) > 12000) {
        if (this.jobQueue.markFailed(event.jobId, 'output_limit_exceeded')) this.metrics.totalJobsFailed++;
        session.abortController.abort(); this.safeCloseSocket(session.upstreamWs);
        if (session.currentShardId) { this.releaseShard(session.currentShardId); session.currentShardId = undefined; }
        return;
      }
      // Keep the receipt independent of the asynchronously fanned-out SSE ring.
      session.receiptText = text;
    }
    this.telemetry.output(event.jobId);
    const token: JobTokenRecord = {
      id: `${event.jobId}_${allocation.seqNo}`,
      jobId: event.jobId,
      seqNo: allocation.seqNo,
      text: event.text,
      isFinal: false,
      timestampMs: event.timestampMs,
    };
    this.metrics.totalTokensEmitted++;
    this.jobBus.publish({ type: 'job:token', jobId: event.jobId, token });
  }

  private handleTransportCompleted(event: JobBusEventOf<'job:transport_completed'>): void {
    const session = this.sessions.get(event.jobId);
    if (!session || session.activeAttemptId !== event.attemptId) return;
    const job = this.jobsTable.get(event.jobId);
    if (!job || ['failed', 'cancelled', 'completed'].includes(job.status)) return;
    try {
      const outputToolCalls = completedFunctionCalls(event.response, job.functionContract);
      if (session.outputBudget && !session.outputBudget.finishTools(outputToolCalls)) { this.stopForOutputBudget(job.id); return; }
      if (outputToolCalls.length) this.jobsTable.put(job.id, { ...job, outputToolCalls });
    } catch {
      this.jobQueue.markFailed(job.id, 'invalid_tool_response');
      this.releaseShard(event.shardId); session.currentShardId = undefined;
      this.safeCloseSocket(session.upstreamWs); session.upstreamWs = undefined;
      return;
    }
    if (job?.durableReceipt) {
      try {
        // Commit evidence before announcing completion to any subscriber.
        this.receiptStore().complete(job.id, job.tenantId, session.receiptText ?? '',
          completionUsage(event.response, job.retryCount ?? 0, job.failoverCount ?? 0));
      } catch {
        this.jobQueue.markFailed(job.id, 'receipt_commit_unavailable');
        this.releaseShard(event.shardId); session.currentShardId = undefined;
        this.safeCloseSocket(session.upstreamWs); session.upstreamWs = undefined;
        return;
      }
    }
    if (this.jobQueue.markComplete(event.jobId, event.response)) {
      this.metrics.totalJobsCompleted++;
      this.retryBudget.success();
      this.releaseShard(event.shardId, true);
      session.currentShardId = undefined;
      this.safeCloseSocket(session.upstreamWs);
      session.upstreamWs = undefined;
    }
  }

  private handleTransportDrop(event: JobBusEventOf<'job:transport_drop'>): void {
    const session = this.sessions.get(event.jobId);
    if (!session || session.abortController.signal.aborted || session.activeAttemptId !== event.attemptId) return;
    const job = this.jobsTable.get(event.jobId);
    if (
      !job ||
      job.status === 'completed' ||
      job.status === 'cancelled' ||
      job.status === 'failed'
    ) {
      return;
    }

    // This attempt returns its capacity once. A later cancellation during
    // retry backoff must not release another job's slot on the same shard.
    if (session.currentShardId !== event.shardId) return;
    session.currentShardId = undefined;
    if (event.providerFailureObserved) this.jobsTable.put(job.id, { ...job, providerFailureObserved: true });
    this.telemetry.failedAttempt(event.jobId, event.reason);
    // A metered request is one provider attempt. A retry would require another
    // independently reserved operation and evidence for both attempts.
    if (event.retryable === false) {
      this.releaseShard(event.shardId);
      if (this.jobQueue.markFailed(event.jobId, event.reason)) this.metrics.totalJobsFailed++;
      return;
    }
    if (event.isQuotaError) {
      this.metrics.totalShardCooldownEjections++;
      this.recordQuotaFailure(event.shardId, event.retryAtMs, true, event.jobId);
    } else if (event.providerFailureObserved) {
      this.recordShardFailure(event.shardId, event.unauthorized);
    } else {
      this.releaseShard(event.shardId);
    }

    if (job.durableReceipt) {
      // Preserve health/cooldown observations even though this job cannot retry.
      if (this.jobQueue.markFailed(event.jobId, event.reason)) this.metrics.totalJobsFailed++;
      return;
    }

    if (job.functionContract?.tools.length || session.retryCount >= this.config.maxUpstreamRetries) {
      if (event.isQuotaError && this.config.executionPolicy && !job.durableReceipt) {
        this.jobsTable.put(job.id, { ...this.jobsTable.get(job.id)!, continuationAllowed: true });
      }
      if (this.jobQueue.markFailed(event.jobId, `retries_exhausted_${event.reason}`)) {
        this.metrics.totalJobsFailed++;
      }
      return;
    }

    if (!this.retryBudget.take()) {
      if (this.jobQueue.markFailed(event.jobId, 'relay_retry_budget_exhausted')) this.metrics.totalJobsFailed++;
      return;
    }
    session.retryCount++;
    this.metrics.totalUpstreamRetries++;
    const baseDelay = this.config.retryBaseDelayMs * Math.pow(2, session.retryCount - 1);
    const backoffMs = Math.floor(Math.random() * (Math.min(this.config.retryMaxDelayMs, baseDelay) + 1));
    console.warn(
      `[AntiFragileRelay] Upstream failure (${event.reason}) on shard ${event.shardId}. ` +
      `Scheduling queue-owned recovery ${session.retryCount}/${this.config.maxUpstreamRetries} in ${backoffMs}ms...`,
    );
    session.retryAtMs = Date.now() + backoffMs;
    session.retryTimer = setTimeout(() => {
      session.retryAtMs = undefined;
      if (!session.abortController.signal.aborted && session.activeAttemptId === event.attemptId) {
        void this.performInFlightFailover(event.jobId, event.reason, event.shardId).catch(() => {
          if (this.jobQueue.markFailed(event.jobId, 'relay_recovery_failed')) this.metrics.totalJobsFailed++;
        });
      }
    }, backoffMs);
  }

  private async performInFlightFailover(jobId: string, reason: string, failedShardId: string): Promise<void> {
    const session = this.sessions.get(jobId);
    if (!session || session.abortController.signal.aborted) return;

    const currentJob = this.jobsTable.get(jobId);
    if (
      !currentJob ||
      currentJob.status === 'cancelled' ||
      currentJob.status === 'completed' ||
      currentJob.status === 'failed'
    ) {
      return;
    }

    // Slack Flannel Downstream Failover Keepalive: Send immediate SSE comment to reset proxy idle timers
    this.metrics.totalDownstreamFailoverKeepalivesSent++;
    this.jobBus.publish({
      type: 'job:keepalive',
      jobId,
      text: `: transit_failover_in_progress reason=${reason}\n\n`,
    });

    // Start 1s keepalive heartbeat ticker during shard handover
    if (session.downstreamFailoverKeepaliveTimer) clearInterval(session.downstreamFailoverKeepaliveTimer);
    session.downstreamFailoverKeepaliveTimer = setInterval(() => {
      if (session.abortController.signal.aborted) {
        if (session.downstreamFailoverKeepaliveTimer) {
          clearInterval(session.downstreamFailoverKeepaliveTimer);
          session.downstreamFailoverKeepaliveTimer = undefined;
        }
        return;
      }
      this.metrics.totalDownstreamFailoverKeepalivesSent++;
      this.jobBus.publish({ type: 'job:keepalive', jobId, text: ': transit_failover_in_progress\n\n' });
    }, 1000);

    try { await this.refreshShardRegistry(); } catch {
      if (this.jobQueue.markFailed(jobId, 'shard_registry_unavailable')) this.metrics.totalJobsFailed++;
      return;
    }
    // A cancellation or deadline may have finished the job while refresh awaited I/O.
    if (session.abortController.signal.aborted || this.sessions.get(jobId) !== session) return;
    // 1. Acquire alternative healthy shard
    const newShard = this.acquireHealthyShard(session.attemptedShardIds, currentJob.model, false, currentJob.id);
    if (!newShard) {
      console.warn(`[AntiFragileRelay] In-flight failover failed: No alternate healthy shards available.`);
      if (session.downstreamFailoverKeepaliveTimer) {
        clearInterval(session.downstreamFailoverKeepaliveTimer);
        session.downstreamFailoverKeepaliveTimer = undefined;
      }
      if (this.jobQueue.markFailed(jobId, `all_shards_exhausted_during_failover_${reason}`)) {
        this.metrics.totalJobsFailed++;
      }
      return;
    }

    session.attemptedShardIds.add(newShard.id);
    this.metrics.totalMidStreamFailoversWon++;
    console.log(`[AntiFragileRelay] Seamless failover engaged for job ${jobId}: ${failedShardId} -> ${newShard.id} (Tokens emitted so far: ${currentJob.seqCounter})`);

    // 2. Prepare payload
    const jobUpdates: Partial<JobRecord> = {
      shardId: newShard.id,
      failoverCount: (currentJob.failoverCount || 0) + 1,
      status: currentJob.seqCounter > 0 ? 'streaming' : 'running',
    };
    let priorFailoverSuffix: string | undefined;

    // If tokens have already been emitted, augment conversation with partial assistant response + continuation prompt
    if (currentJob.seqCounter > 0) {
      const emittedTokens = this.tokensTable.query({
        where: { jobId },
        sortBy: 'seqNo',
        sortOrder: 'asc',
      });
      const accumulatedText = emittedTokens.map((t) => t.text).join('');

      // Arm Figma / Liveblocks Overlap Reconciliation for first chunk from new shard
      priorFailoverSuffix = accumulatedText.slice(-this.config.deDuplicationOverlapWindowChars);

      try {
        const originalMessages: Array<{ role: string; content: string }> = JSON.parse(currentJob.messagesJson || '[]');
        const resumedMessages = [
          ...originalMessages,
          { role: 'assistant', content: accumulatedText },
          {
            role: 'user',
            content: '[TRANSIT_FAILOVER_DIRECTIVE]: An upstream network connection interrupted your output stream. Please continue the response seamlessly from the exact word/character where you stopped above. Do not repeat any prior text.',
          },
        ];
        jobUpdates.messagesJson = JSON.stringify(resumedMessages);
      } catch {
        // Fallback to original messages
      }
    }

    const updatedJob = this.jobQueue.updateForFailover(jobId, jobUpdates);
    if (!updatedJob) {
      this.releaseShard(newShard.id);
      return;
    }
    session.currentShardId = newShard.id;
    const attempt: TransportAttempt = {
      id: ++session.activeAttemptId,
      shardId: newShard.id,
      hasReceivedFirstToken: false,
      heartbeatPending: false,
      completionObserved: false,
      isFirstChunkAfterFailover: priorFailoverSuffix !== undefined,
      priorFailoverSuffix,
    };

    // 3. Open exactly the acquired replacement shard. No second acquisition.
    await this._openUpstreamTransport(updatedJob, newShard, attempt);
  }

  // --------------------------------------------------------------------------
  // CLEAN CANCEL & JOB STATUS
  // --------------------------------------------------------------------------

  private jobRecovery(job: JobRecord) {
    const session = this.sessions.get(job.id);
    const terminal = ['completed', 'failed', 'cancelled'].includes(job.status);
    return {
      state: terminal ? 'stopped' : session?.retryAtMs !== undefined ? 'backoff' : 'running',
      retriesUsed: session?.retryCount ?? job.failoverCount ?? 0,
      maxRetries: this.config.maxUpstreamRetries,
      nextRetryAtMs: terminal ? null : session?.retryAtMs ?? null,
      deadlineAtMs: job.createdAtMs + this.config.jobMaxWallTimeMs,
      automaticRetry: !terminal && session?.retryAtMs !== undefined,
    };
  }

  private handleJobStatus(jobId: string, res: http.ServerResponse): void {
    const job = this.jobsTable.get(jobId);
    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Job ${jobId} not found`, code: 'job_not_found' } }));
      return;
    }

    const terminal = ['completed', 'failed', 'cancelled'].includes(job.status);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(!terminal ? { 'Retry-After': '2' } : {}) });
    res.end(JSON.stringify({
      id: job.id,
      model: job.model,
      status: job.status,
      outputChunks: job.seqCounter,
      tokensGenerated: null,
      traceId: job.traceId ?? null,
      terminal,
      recovery: this.jobRecovery(job),
      pollAfterMs: terminal ? null : 2000,
      createdAt: Math.floor(job.createdAtMs / 1000),
      durationMs: ((job.completedAtMs as number) || Date.now()) - job.createdAtMs,
      streamUrl: `/v1/jobs/${job.id}/stream`,
      error: job.error || null,
    }));
  }

  private handleJobCancel(jobId: string, res: http.ServerResponse): void {
    const job = this.jobsTable.get(jobId);
    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Job ${jobId} not found`, code: 'job_not_found' } }));
      return;
    }

    const session = this.sessions.get(jobId);
    if (session?.graceTimer) clearTimeout(session.graceTimer);

    const cancelled = this.jobQueue.markCancelled(jobId, 'user_cancelled');
    if (cancelled) this.metrics.totalJobsCancelled++;

    if (cancelled && session) {
      if (session.wallTimer) clearTimeout(session.wallTimer);
      if (session.downstreamFailoverKeepaliveTimer) {
        clearInterval(session.downstreamFailoverKeepaliveTimer);
        session.downstreamFailoverKeepaliveTimer = undefined;
      }
      session.abortController.abort(new Error('User cancelled job'));
      this.safeCloseSocket(session.upstreamWs);
    }

    if (cancelled && session?.currentShardId) {
      this.releaseShard(session.currentShardId);
      session.currentShardId = undefined;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: job.id,
      status: cancelled ? 'cancelled' : this.jobsTable.get(jobId)?.status,
      outputChunks: job.seqCounter,
      tokensGenerated: null,
      cancellationApplied: cancelled,
      refunded: null,
      refundStatus: 'not_managed_by_relay',
    }));
  }

  // --------------------------------------------------------------------------
  // ATOMIC CHECKPOINTING & CRASH RECOVERY (RocksDB / Redis Snapshot Pattern)
  // --------------------------------------------------------------------------

  private saveStateSnapshot(): void {
    try {
      const snapDir = path.dirname(this.config.stateSnapshotPath);
      if (!fs.existsSync(snapDir)) {
        fs.mkdirSync(snapDir, { recursive: true });
      }

      const activeJobs = this.jobsTable.getAll().filter(
        (j) => j.status === 'queued' || j.status === 'running' || j.status === 'streaming'
      );

      const snapshot = {
        timestampMs: Date.now(),
        jobs: activeJobs,
        shards: this.shardsTable.getAll().map(s => ({
          id: s.id, credentialFingerprint: s.credentialFingerprint, status: s.status, cooldownUntilMs: s.cooldownUntilMs,
          consecutiveFailures: s.consecutiveFailures, quotaFailures: s.quotaFailures,
          imageCooldownUntilMs: s.imageCooldownUntilMs, imageConsecutiveFailures: s.imageConsecutiveFailures,
          imageQuotaFailures: s.imageQuotaFailures, lastImageQuotaFailureJobId: s.lastImageQuotaFailureJobId,
          providerLimits: s.providerLimits, lastUsedAtMs: s.lastUsedAtMs,
          slidingWindowTimestamps: s.slidingWindowTimestamps,
        })),
        metrics: this.metrics,
      };

      const tmpPath = `${this.config.stateSnapshotPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmpPath, this.config.stateSnapshotPath); // Atomic POSIX rename
    } catch (err: any) {
      console.error('[BroccoliDB Relay] Snapshot checkpoint failed:', err.message);
    }
  }

  private recoverStateSnapshot(): void {
    // A checkpoint contains health/configuration evidence, never live
    // ownership. Any runtime occupancy belongs to this process only.
    this.runtimeShardOwnership.clear();
    if (!fs.existsSync(this.config.stateSnapshotPath)) return;

    try {
      const raw = fs.readFileSync(this.config.stateSnapshotPath, 'utf-8');
      const snap = JSON.parse(raw);

      for (const state of Array.isArray(snap.shards) ? snap.shards : []) {
        // Legacy local exhaustion without provider evidence is not a real quota.
        this.recoveredShardState.set(state.id, {
          credentialFingerprint: state.credentialFingerprint,
          status: state.status === 'disabled' ? 'disabled' : state.cooldownUntilMs > Date.now() ? 'cooldown' : 'active',
          cooldownUntilMs: state.cooldownUntilMs, quotaFailures: state.quotaFailures,
          imageCooldownUntilMs: state.imageCooldownUntilMs, imageQuotaFailures: state.imageQuotaFailures,
          imageConsecutiveFailures: state.imageConsecutiveFailures, lastImageQuotaFailureJobId: state.lastImageQuotaFailureJobId,
          consecutiveFailures: state.consecutiveFailures, lastUsedAtMs: state.lastUsedAtMs,
          providerLimits: state.providerLimits,
          slidingWindowTimestamps: (state.slidingWindowTimestamps ?? []).filter((t: number) => Number.isFinite(t)).sort((a: number, b: number) => a - b),
        });
      }
      if (Array.isArray(snap.jobs) && Number.isFinite(snap.timestampMs) && Date.now() - snap.timestampMs < this.config.jobTokenRetentionMs) {
        for (const job of snap.jobs) {
          if (!job || typeof job.id !== 'string' || typeof job.tenantId !== 'string') continue;
          // Transports and output buffers are not checkpointed. Never advertise
          // a resumable stream or silently repeat provider work after a crash.
          this.jobQueue.restore({
            ...job,
            isDetached: false,
            status: 'failed',
            completedAtMs: Date.now(),
            error: 'relay_restarted_start_new_request',
          });
        }
        console.log(`[BroccoliDB Relay] Recovered ${snap.jobs.length} in-flight jobs from checkpoint snapshot.`);
      }
    } catch {}
  }

  private startPeriodicSnapshot(): void {
    this.snapshotIntervalTimer = setInterval(() => {
      this.saveStateSnapshot();
    }, this.config.snapshotIntervalMs);
    this.snapshotIntervalTimer.unref?.();
  }

  // --------------------------------------------------------------------------
  // HEALTH & OBSERVABILITY
  // --------------------------------------------------------------------------

  private handleHealth(res: http.ServerResponse, readiness = false): void {
    const mem = process.memoryUsage();
    const activeJobs = this.jobsTable.getAll().filter(
      (record) => record.status === 'running' || record.status === 'streaming'
    );
    const allShards = this.shardsTable.getAll();

    const admission = this.admissionState();
    const capability = this.capabilitySnapshot();
    if (readiness && !capability.models.some(m => m.eligibleShardCount > 0)) { admission.accepting = false; admission.reason = 'model_temporarily_unavailable'; }
    const healthData = {
      capability,
      status: readiness && !admission.accepting ? 'not_ready' : 'ok',
      admission,
      service: 'galxai-relay',
      signature: 'galxai-zenith-relay',
      port: this.config.port,
      host: this.config.host,
      version: '2.6.0',
      storageEngine: 'BroccoliDB Zenith Tier',
      uptimeSec: Math.floor((Date.now() - this.metrics.startTimeMs) / 1000),
      shards: {
        total: allShards.length,
        active: allShards.filter((s) => this.shardStats(s).status === 'active').length,
        exhausted: allShards.filter((s) => this.shardStats(s).status === 'cooldown').length,
        cooldown: allShards.filter((s) => this.shardStats(s).status === 'cooldown').length,
        disabled: allShards.filter((s) => this.shardStats(s).status === 'disabled').length,
      },
      jobs: {
        active: activeJobs.length,
        totalSubmitted: this.metrics.totalJobsSubmitted,
        totalCompleted: this.metrics.totalJobsCompleted,
        attachedDuplicates: this.metrics.totalAttachedDuplicates,
      },
      antiFragility: {
        totalUpstreamRetries: this.metrics.totalUpstreamRetries,
        totalMidStreamFailoversWon: this.metrics.totalMidStreamFailoversWon,
        totalShardCooldownEjections: this.metrics.totalShardCooldownEjections,
        totalDeadPeerRecoveries: this.metrics.totalDeadPeerRecoveries,
        totalReasoningChunksReceived: this.metrics.totalReasoningChunksReceived,
        totalHeartbeatAckMisses: this.metrics.totalHeartbeatAckMisses,
        totalOverlapReconciliationsWon: this.metrics.totalOverlapReconciliationsWon,
        totalDownstreamFailoverKeepalivesSent: this.metrics.totalDownstreamFailoverKeepalivesSent,
        totalProactiveRateLimitCooldowns: this.metrics.totalProactiveRateLimitCooldowns,
        totalBusEventsEmitted: this.metrics.totalBusEventsEmitted,
        totalSlowSubscriberDrains: this.metrics.totalSlowSubscriberDrains,
      },
      security: {
        authEnabled: Boolean(this.config.apiKeys?.length || this.config.adminApiKeys?.length),
        rateGovernorActive: true,
        maxPayloadBytes: this.config.maxPayloadBytes,
      },
      broccolidb: {
        jobsTableCount: this.jobsTable.count(),
        tokensTableCount: this.tokensTable.count(),
        idempotencyTableCount: this.idempotencyTable.count(),
      },
      memory: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      },
    };

    res.writeHead(readiness && !admission.accepting ? 503 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(healthData, null, 2));
  }

  private handleMetrics(res: http.ServerResponse): void {
    const activeJobs = this.jobsTable.getAll().filter(
      (record) => record.status === 'running' || record.status === 'streaming'
    );

    const lines = [
      '# HELP galxai_relay_jobs_in_flight Current active inference jobs',
      '# TYPE galxai_relay_jobs_in_flight gauge',
      `galxai_relay_jobs_in_flight ${activeJobs.length}`,
      '# HELP galxai_relay_jobs_submitted_total Total jobs submitted',
      '# TYPE galxai_relay_jobs_submitted_total counter',
      `galxai_relay_jobs_submitted_total ${this.metrics.totalJobsSubmitted}`,
      '# HELP galxai_relay_jobs_completed_total Total jobs completed',
      '# TYPE galxai_relay_jobs_completed_total counter',
      `galxai_relay_jobs_completed_total ${this.metrics.totalJobsCompleted}`,
      '# HELP galxai_relay_attached_duplicates_total Duplicate prompts attached to in-flight stream',
      '# TYPE galxai_relay_attached_duplicates_total counter',
      `galxai_relay_attached_duplicates_total ${this.metrics.totalAttachedDuplicates}`,
      '# HELP galxai_relay_tokens_emitted_total Total tokens emitted over wire',
      '# TYPE galxai_relay_tokens_emitted_total counter',
      `galxai_relay_tokens_emitted_total ${this.metrics.totalTokensEmitted}`,
      '# HELP galxai_relay_tokens_buffer_replayed_total Tokens served from BroccoliDB resume buffer',
      '# TYPE galxai_relay_tokens_buffer_replayed_total counter',
      `galxai_relay_tokens_buffer_replayed_total ${this.metrics.totalTokensServedFromBuffer}`,
      '# HELP galxai_relay_reconnections_total Total client stream reconnections',
      '# TYPE galxai_relay_reconnections_total counter',
      `galxai_relay_reconnections_total ${this.metrics.totalReconnections}`,
      '# HELP galxai_relay_grace_reconnections_total Reconnections saved by grace window',
      '# TYPE galxai_relay_grace_reconnections_total counter',
      `galxai_relay_grace_reconnections_total ${this.metrics.totalGraceReconnectionsWon}`,
      '# HELP galxai_relay_zombie_leash_aborts_total Total zombie upstream aborts',
      '# TYPE galxai_relay_zombie_leash_aborts_total counter',
      `galxai_relay_zombie_leash_aborts_total ${this.metrics.totalZombieLeashAborts}`,
      '# HELP galxai_relay_itl_stalls_total Total ITL stalls flagged',
      '# TYPE galxai_relay_itl_stalls_total counter',
      `galxai_relay_itl_stalls_total ${this.metrics.totalItlStallsDetected}`,
      '# HELP galxai_relay_ttft_deadlocks_total Total TTFT deadlocks detected',
      '# TYPE galxai_relay_ttft_deadlocks_total counter',
      `galxai_relay_ttft_deadlocks_total ${this.metrics.totalTtftDeadlocks}`,
      '# HELP galxai_relay_upstream_retries_total Total in-flight upstream failover retries',
      '# TYPE galxai_relay_upstream_retries_total counter',
      `galxai_relay_upstream_retries_total ${this.metrics.totalUpstreamRetries}`,
      '# HELP galxai_relay_midstream_failovers_won_total Seamless mid-stream failovers without client error',
      '# TYPE galxai_relay_midstream_failovers_won_total counter',
      `galxai_relay_midstream_failovers_won_total ${this.metrics.totalMidStreamFailoversWon}`,
      '# HELP galxai_relay_shard_cooldown_ejections_total Shards ejected to cooldown due to 429 or quota exhaustion',
      '# TYPE galxai_relay_shard_cooldown_ejections_total counter',
      `galxai_relay_shard_cooldown_ejections_total ${this.metrics.totalShardCooldownEjections}`,
      '# HELP galxai_relay_dead_peer_recoveries_total Half-open or dead TCP peer connections evicted',
      '# TYPE galxai_relay_dead_peer_recoveries_total counter',
      `galxai_relay_dead_peer_recoveries_total ${this.metrics.totalDeadPeerRecoveries}`,
      '# HELP galxai_relay_reasoning_chunks_received_total Reasoning delta progress frames processed',
      '# TYPE galxai_relay_reasoning_chunks_received_total counter',
      `galxai_relay_reasoning_chunks_received_total ${this.metrics.totalReasoningChunksReceived}`,
      '# HELP galxai_relay_heartbeat_ack_misses_total Discord-style Heartbeat ACK misses detecting dead peers',
      '# TYPE galxai_relay_heartbeat_ack_misses_total counter',
      `galxai_relay_heartbeat_ack_misses_total ${this.metrics.totalHeartbeatAckMisses}`,
      '# HELP galxai_relay_overlap_reconciliations_won_total LLM continuation overlaps deduplicated without stutter',
      '# TYPE galxai_relay_overlap_reconciliations_won_total counter',
      `galxai_relay_overlap_reconciliations_won_total ${this.metrics.totalOverlapReconciliationsWon}`,
      '# HELP galxai_relay_failover_keepalives_sent_total Downstream SSE failover keepalive comment frames sent',
      '# TYPE galxai_relay_failover_keepalives_sent_total counter',
      `galxai_relay_failover_keepalives_sent_total ${this.metrics.totalDownstreamFailoverKeepalivesSent}`,
      '# HELP galxai_relay_proactive_rate_limit_cooldowns_total Proactive shard cooldown transitions triggered by rate_limits.updated',
      '# TYPE galxai_relay_proactive_rate_limit_cooldowns_total counter',
      `galxai_relay_proactive_rate_limit_cooldowns_total ${this.metrics.totalProactiveRateLimitCooldowns}`,
      '# HELP galxai_relay_bus_events_emitted_total Events dispatched through the asynchronous job bus',
      '# TYPE galxai_relay_bus_events_emitted_total counter',
      `galxai_relay_bus_events_emitted_total ${this.metrics.totalBusEventsEmitted}`,
      '# HELP galxai_relay_slow_subscriber_drains_total Subscriber writes that entered independent drain handling',
      '# TYPE galxai_relay_slow_subscriber_drains_total counter',
      `galxai_relay_slow_subscriber_drains_total ${this.metrics.totalSlowSubscriberDrains}`,
      '# HELP galxai_relay_rate_limit_drops_total Total requests dropped by token bucket rate limiter',
      '# TYPE galxai_relay_rate_limit_drops_total counter',
      `galxai_relay_rate_limit_drops_total ${this.metrics.totalRateLimitDrops}`,
      '# HELP galxai_relay_auth_failures_total Total 401 unauthorized requests',
      '# TYPE galxai_relay_auth_failures_total counter',
      `galxai_relay_auth_failures_total ${this.metrics.totalAuthFailures}`,
      '# HELP galxai_relay_broccolidb_tokens_count Active token records in BroccoliDB',
      '# TYPE galxai_relay_broccolidb_tokens_count gauge',
      `galxai_relay_broccolidb_tokens_count ${this.tokensTable.count()}`,
    ];

    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(lines.join('\n') + '\n');
  }

  private handleDashboard(res: http.ServerResponse, filename = 'dashboard.html'): void {
    try {
      const candidatePaths = [
        path.join(process.cwd(), 'src', 'relay', filename),
        path.join(process.cwd(), filename),
        path.join('/app/src/relay', filename),
      ];

      for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
          const html = fs.readFileSync(p, 'utf-8');
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
          });
          res.end(html);
          return;
        }
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Dashboard HTML file not found.');
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Error loading dashboard: ${err.message}`);
    }
  }

  private handleDashboardStats(res: http.ServerResponse): void {
    const allShards = this.shardsTable.getAll();
    const activeJobs = this.jobsTable.getAll().filter(
      (j) => j.status === 'running' || j.status === 'streaming'
    );
    const recentJobs = [...this.jobsTable.getAll()].sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 20);

    const now = Date.now();
    const effectiveCap = this.currentQuotaProfile.maxCalls || null;
    const windowDurationMs = this.currentQuotaProfile.windowDurationMs;

    const firstOutputs = this.telemetry.snapshot().traces.flatMap(t => t.firstOutputMs === undefined ? [] : [t.firstOutputMs]);
    const stats = {
      status: 'ok',
      service: 'galxai-relay',
      signature: 'galxai-zenith-relay',
      security: { authenticationRequired: Boolean(this.config.apiKeys?.length || this.config.adminApiKeys?.length), administratorAccess: true },
      port: this.config.port,
      host: this.config.host,
      activeStreams: activeJobs.length,
      totalRequests: this.metrics.totalJobsCompleted + this.metrics.totalImageJobsCompleted,
      avgTtftMs: firstOutputs.length ? Math.round(firstOutputs.reduce((a, b) => a + b, 0) / firstOutputs.length) : null,
      uptimeSec: Math.floor((Date.now() - this.metrics.startTimeMs) / 1000),
      memory: process.memoryUsage(),
      registry: { source: this.config.registryEnabled ? 'PostgreSQL registry' : 'local credentials',
        error: this.registryError, ...this.registryCounts },
      quotaEngine: {
        mode: this.currentQuotaProfile.mode, baseCap: effectiveCap, effectiveCap,
        uncapped: effectiveCap === null, windowDurationMs,
        fleetTotalCap: effectiveCap === null ? null : allShards.length * effectiveCap,
        maxUpstreamRetries: this.config.maxUpstreamRetries,
        shardConcurrency: this.config.shardConcurrency,
        retryAfterSec: this.fleetRetryAfter(),
      },
      shards: allShards.map(s => this.shardStats(s, now)),
      database: {
        jobs: this.jobsTable.count(),
        tokens: this.tokensTable.count(),
        shards: this.shardsTable.count(),
        idempotency: this.idempotencyTable.count(),
      },
      activeJobsList: recentJobs.map((j) => ({
        id: j.id,
        model: j.model,
        status: j.status,
        recovery: this.jobRecovery(j),
        error: j.error ?? null,
        outputChunks: j.seqCounter,
        tokensStreamed: null,
        createdAtMs: j.createdAtMs,
      })),
    };

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    });
    res.end(JSON.stringify(stats));
  }

  private shardStats(s: ShardRecord, now = Date.now()) {
    const cap = this.currentQuotaProfile.maxCalls || null;
    const duration = this.currentQuotaProfile.windowDurationMs;
    const timestamps = s.slidingWindowTimestamps.filter(t => t > now - duration);
    const readyAt = this.shardReadyAt(s, now);
    const limits = (s.providerLimits ?? []).filter(l => !l.resetAtMs || l.resetAtMs > now);
    return {
      id: s.id, accountId: s.accountId, source: s.source,
      expiresAtMs: s.expiresAtMs ?? null,
      availabilityReason: s.expiresAtMs !== undefined && s.expiresAtMs <= now ? 'credential_expired'
        : s.status === 'disabled' ? 'credential_rejected'
        : this.config.registryEnabled && (this.registryError || now - this.registryRefreshedAtMs > 5000) ? 'registry_unavailable'
        : readyAt > now ? 'cooldown' : s.probeInFlight ? 'probing'
        : s.inFlight >= this.config.shardConcurrency ? 'at_capacity' : 'ready',
      eligible: Number.isFinite(readyAt) && readyAt <= now && !s.probeInFlight && s.inFlight < this.config.shardConcurrency
        && !(this.config.registryEnabled && (this.registryError || now - this.registryRefreshedAtMs > 5000)),
      status: !Number.isFinite(readyAt) ? 'disabled' : readyAt > now ? 'cooldown' : s.probeInFlight ? 'probing' : 'active',
      inFlight: s.inFlight, maxConcurrency: this.config.shardConcurrency,
      consecutiveFailures: s.consecutiveFailures, quotaFailures: s.quotaFailures ?? 0,
      slidingWindowUsage: timestamps.length, slidingWindowCap: cap,
      slidingWindowTimestamps: timestamps.slice(-100), historyTruncated: timestamps.length > 100,
      windowDurationMs: duration, lastUsedAtMs: s.lastUsedAtMs,
      cooldownUntilMs: Number.isFinite(readyAt) ? readyAt : null,
      retryAfterSec: Number.isFinite(readyAt) ? Math.max(0, Math.ceil((readyAt - now) / 1000)) : null,
      providerLimits: limits,
      quotaKnown: limits.length > 0,
      headroom: cap === null ? null : Math.max(0, cap - timestamps.length),
    };
  }

  private async handleSetQuotaProfile(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const data = await readJsonBody(req, Math.min(this.config.maxPayloadBytes, 16384), this.config.httpBodyTimeoutMs);
      const requestedMode = data.mode as QuotaMode;

      if (requestedMode && !Object.hasOwn(QUOTA_PRESETS, requestedMode)) throw new Error('Unknown quota mode');
      const next = { ...(requestedMode ? QUOTA_PRESETS[requestedMode] : this.currentQuotaProfile) };
      if (data.customCap !== undefined) {
        if (!Number.isSafeInteger(data.customCap) || data.customCap < 0) throw new Error('customCap must be a nonnegative integer; 0 removes the local cap');
        next.maxCalls = data.customCap;
      }
      if (data.customWindowMin !== undefined) {
        if (!Number.isFinite(data.customWindowMin) || data.customWindowMin <= 0 || data.customWindowMin > 10080) throw new Error('customWindowMin must be between 0 and 10080');
        next.windowDurationMs = data.customWindowMin * 60_000;
      }
      next.dripRefillSec = 0;
      next.elasticBurstAllowance = 0;
      this.currentQuotaProfile = next;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        profile: this.currentQuotaProfile,
        effectiveCap: this.currentQuotaProfile.maxCalls || null,
        message: `Quota profile updated to ${this.currentQuotaProfile.mode.toUpperCase()}`,
      }));
    } catch (err: any) {
      res.writeHead(err instanceof RequestError ? err.status : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: err instanceof RequestError ? err.code : 'invalid_quota_profile', message: err.message } }));
    }
  }

  private async handleResetQuota(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const data = await readJsonBody(req, Math.min(this.config.maxPayloadBytes, 16384), this.config.httpBodyTimeoutMs);
      const shardId = data.shardId;

      const allShards = this.shardsTable.getAll();
      let resetCount = 0;

      for (const shard of allShards) {
        if (!shardId || shard.id === shardId) {
          this.persistShard({
            ...shard,
            slidingWindowTimestamps: [],
            // Only clear local history; provider cooldowns and disabled credentials remain.
          });
          resetCount++;
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        resetCount,
        message: `Cleared local history for ${resetCount} shard(s); provider cooldowns remain`,
      }));
    } catch (err: any) {
      res.writeHead(err instanceof RequestError ? err.status : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: err instanceof RequestError ? err.code : 'invalid_quota_reset', message: err.message } }));
    }
  }

  private handleQuotaStatus(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ profile: this.currentQuotaProfile,
      effectiveCap: this.currentQuotaProfile.maxCalls || null,
      shards: this.shardsTable.getAll().map(s => this.shardStats(s)),
    }));
  }

  private async handleSyncShards(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (this.config.registryEnabled) await this.refreshShardRegistry(true);
      else this.loadShardFleet();
      const allShards = this.shardsTable.getAll();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        enrolledCount: allShards.length,
        shards: allShards.map((s) => ({ id: s.id, accountId: s.accountId, status: s.status })),
        message: `Successfully synchronized ${allShards.length} shards in the fleet pool.`,
      }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Failed to sync shards: ${err.message}` } }));
    }
  }

  private async handleEnrollShard(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.writeHead(410, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
    res.end(JSON.stringify({ error: { code: 'connection_unavailable',
      message: 'Provider connections are unavailable.',
    } }));
  }

  private handleListShards(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', totalCount: this.shardsTable.count(),
      registry: { source: this.config.registryEnabled ? 'PostgreSQL registry' : 'local credentials', error: this.registryError, ...this.registryCounts },
      shards: this.shardsTable.getAll().map(s => this.shardStats(s)),
    }));
  }

  // --------------------------------------------------------------------------
  // LIFECYCLE CONTROLS (START & GRACEFUL DRAIN)
  // --------------------------------------------------------------------------

  public async start(): Promise<void> {
    this.eventLoopDelay.enable();
    await this.refreshShardRegistry(true);
    await this.refreshCapabilities();
    const schedule = () => {
      if (this.isDraining) return;
      this.capabilityTimer = setTimeout(async () => { await this.refreshCapabilities(); schedule(); },
        Math.max(1000, Math.floor(this.config.capabilityRefreshMs * (0.8 + Math.random() * 0.2))));
      this.capabilityTimer.unref?.();
    };
    schedule();
    return new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.eventLoopDelay.disable();
        if (this.snapshotIntervalTimer) clearInterval(this.snapshotIntervalTimer);
        reject(error);
      };
      this.server.once('error', onError);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off('error', onError);
        console.log(`[NOVA Relay] Listening on http://${this.config.host}:${this.config.port}`);
        console.log(`[NOVA Relay] Shards enrolled: ${this.shardsTable.count()} | Target WS: ${this.config.wsEndpoint}`);
        resolve();
      });
    });
  }

  public listeningPort(): number { const address = this.server.address(); if (!address || typeof address === 'string') throw Error('Relay is not listening.'); return address.port; }

  public stop(): Promise<void> {
    this.stopping ??= this.drainAndStop();
    return this.stopping;
  }

  private async drainAndStop(): Promise<void> {
    this.isDraining = true;
    if (this.capabilityTimer) clearInterval(this.capabilityTimer);
    for (const controller of this.capabilityControllers) controller.abort();
    for (const shard of this.shardsTable.getAll()) this.capabilities.drain(shard.id);
    this.eventLoopDelay.disable();
    if (this.snapshotIntervalTimer) clearInterval(this.snapshotIntervalTimer);
    console.log('[NOVA Relay] Entering graceful drain mode...');
    const forceClose = () => {
      for (const controller of this.imageControllers) controller.abort(new Error('server_draining'));
      for (const [jobId, session] of this.sessions) {
        const shardId = session.currentShardId;
        session.currentShardId = undefined;
        if (this.jobQueue.markFailed(jobId, 'relay_drain_timeout')) this.metrics.totalJobsFailed++;
        session.abortController.abort(new Error('Relay drain timeout'));
        this.safeCloseSocket(session.upstreamWs);
        if (shardId) this.releaseShard(shardId);
      }
      for (const socket of this.sockets) socket.destroy();
    };
    const deadline = setTimeout(forceClose, this.config.drainTimeoutMs);
    try {
      const drained = await this.waitForQueueDrain(this.config.drainTimeoutMs);
      if (!drained) forceClose();
      await this.jobBus.whenIdle();
      this.saveStateSnapshot();
      await new Promise<void>(resolve => {
        this.server.close(() => resolve());
        this.server.closeIdleConnections();
      });
    } finally {
      clearTimeout(deadline);
      this.durableReceipts?.close();
      console.log('[NOVA Relay] HTTP listener closed cleanly.');
    }
  }

  private waitForQueueDrain(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (drained: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(check);
        this.jobBus.removeListener('relay:drained', onDrained);
        resolve(drained);
      };
      const empty = () => this.jobQueue.activeCount() === 0 && this.imageControllers.size === 0 && this.admittedRequests === 0;
      const onDrained = () => { if (empty()) finish(true); };
      this.jobBus.once('relay:drained', onDrained);
      const timer = setTimeout(() => finish(false), timeoutMs);
      const check = setInterval(onDrained, 10);

      // Subscribe before checking to avoid losing the final transition between
      // an empty-state check and listener installation.
      if (empty()) finish(true);
    });
  }
}

// ----------------------------------------------------------------------------
// ENTRYPOINT EXECUTION
// ----------------------------------------------------------------------------

export const GalxaiRelayServer = NovaRelayServer;
export type GalxaiRelayServer = NovaRelayServer;

if (import.meta.url === `file://${process.argv[1]}`) {
  // Global Crash Fence: prevent unhandled exceptions or rejections from terminating the process
  process.on('uncaughtException', (err: Error) => {
    console.error('[NOVA Relay Sentry] Prevented crash on uncaught exception:', err.message);
  });

  process.on('unhandledRejection', (reason: any) => {
    console.error('[NOVA Relay Sentry] Prevented crash on unhandled rejection:', reason);
  });

  const relay = new NovaRelayServer();

  const shutdown = async (signal: string) => {
    console.log(`\n[NOVA Relay] Received ${signal}`);
    await relay.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  relay.start().catch((err) => {
    console.error('[NOVA Relay] Fatal startup error:', err);
    process.exit(1);
  });
}
