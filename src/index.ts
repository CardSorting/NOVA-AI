/**
 * NOVA: Autonomous Inference Relay Gateway & Resource Routing Substrate
 *
 * Provides external inference request routing, multi-worker shard pool management,
 * token bucket rate governance, fault-tolerant admissions, and streaming SSE wire transports.
 */

// Relay Core
export { NovaRelayServer, GalxaiRelayServer } from './relay/relay-server.js';
export { RequestError, RetryBudget, readJsonBody, validateModelRequest } from './relay/request-policy.js';
export { RequestBulkhead } from './relay/request-bulkhead.js';
export { AdmissionReceipts } from './relay/admission-receipts.js';
export { DurableReceipts } from './relay/durable-receipts.js';
export { CapabilityRegistry } from './relay/capability-registry.js';
export { discoverOpenAIModels } from './relay/capability-discovery.js';
export { RelayTelemetry } from './relay/telemetry.js';
export { completionUsage, completionFrame } from './relay/completion-usage.js';
export { OutputBudget } from './relay/output-budget.js';
export {
  classifyImageRelayFailure,
  decodePrivateRelayFailure,
  encodePrivateRelayFailure,
  privateRelayFailure,
  PRIVATE_RELAY_FAILURE_HEADER
} from './relay/private-failure.js';

// Pool Core
export { NovaPoolRuntime, PoolRuntime } from './pools/pool-runtime.js';
export {
  NovaExecution,
  PoolExecution,
  type ExecutionGrant,
  type ExecutionPolicy,
  type AssignedAccount,
  type ExecutionRecord,
  type ExecutionStore,
  MemoryExecutionStore,
  PostgresExecutionStore
} from './pools/pool-execution.js';
export { PoolScheduler, SchedulerQueueError, type SchedulerReservation } from './pools/pool-scheduler.js';
export { NovaRequestQueue, PoolRequestQueue, type QueuedGenerationRequest, type QueuedHttpResponse } from './pools/pool-request-queue.js';
export { centralServer, centralQuery } from './pools/pool-central.js';
export {
  CentralClient,
  PROJECTS,
  hash,
  uuid,
  equalSecret,
  requestWorkload,
  type PoolId,
  type Workload
} from './pools/pool-protocol.js';
export { NovaCredentialPool, GalxCredentialPool, type RemoteShardAuthority, type TelemetrySyncBuffer } from './pools/credential-pool.js';
export { NovaCredentialSubstrate, GalxCredentialSubstrate, type ShardPersistenceAdapter } from './pools/credential-substrate.js';
export { NovaRateGovernor, ContinuousTokenBucketRateGovernor } from './pools/rate-governor.js';
export { NovaCircuitBreaker, GalxCircuitBreaker } from './pools/circuit-breaker.js';
export { coalesceHealthTransitions, persistedHealthStatus, type LeaseHealthTransition } from './pools/lease-transition.js';
export { publicJob, publicUsage } from './pools/pool-public-response.js';

// Storage Primitives
export { BroccoliDbTable } from './storage/memory-table.js';
export { BroccoliAggregateEngine } from './storage/table-aggregation.js';
export type * from './storage/table-contracts.js';

// Client Adapters
export { NovaClient, RelayClient, type RelayClientOptions, type ChatCompletionRequestOptions, type ChatCompletionResponse } from './client/relay-client.js';
export { parseEventStream, type ChatCompletionChunk, type ChatChunkDelta } from './client/stream-parser.js';

// Security & Artifacts
export { sanitizeImageArtifact, decodeImageBase64, type PublicImageArtifact, type ImageFormat } from './security/image-artifact.js';

// Database & Local PostgreSQL
export {
  createDatabasePool,
  getDatabasePool,
  closeDatabasePool,
  checkDatabaseHealth,
  resolveDatabaseUrl,
  withTransaction,
  type DatabaseHealth
} from './db/postgres.js';
export {
  migrateDatabase,
  readSchemaSql,
  readSeedSql,
  type MigrationOptions,
  type MigrationResult
} from './db/migrate.js';

// Contracts
export type * from './pools/pool-contracts.js';

