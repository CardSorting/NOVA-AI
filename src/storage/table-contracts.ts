/**
 * GALXAI: BroccoliDB Core Data Contracts (Zenith Tier)
 * Core interfaces for L1 Reactive Tables (Multi-Modal Indexing, Rich Filters, Natural Queries, CDC),
 * L2 Micro-Batched SHA-256 WAL, L3 CAS Storage, L4 Double-Buffered Checkpointing, and Forensic Diagnostics.
 */

export type DbDurabilityMode = "SYNCHRONOUS" | "MICRO_BATCHED" | "SPECULATIVE";

export type WalOperationType = "INSERT" | "UPDATE" | "DELETE" | "CLEAR" | "CHECKPOINT" | "ROLLBACK" | "BRANCH_MERGE";

export interface WalFrame {
  readonly frameId: number;
  readonly timestamp: number;
  readonly op: WalOperationType;
  readonly table: string;
  readonly recordId: string;
  readonly payload?: Record<string, unknown>;
  readonly checksum: string; // SHA-256 integrity hash
  readonly previousFrameHash?: string; // Cryptographic chaining
}

// -------------------------------------------------------------
// Rich Query DSL & Operator Filters
// -------------------------------------------------------------

export type DbOperator =
  | "$eq"
  | "$ne"
  | "$gt"
  | "$gte"
  | "$lt"
  | "$lte"
  | "$in"
  | "$nin"
  | "$between"
  | "$startsWith"
  | "$endsWith"
  | "$contains"
  | "$regex"
  | "$exists";

export interface DbFieldFilter {
  readonly $eq?: unknown;
  readonly $ne?: unknown;
  readonly $gt?: number | string | Date;
  readonly $gte?: number | string | Date;
  readonly $lt?: number | string | Date;
  readonly $lte?: number | string | Date;
  readonly $in?: readonly unknown[];
  readonly $nin?: readonly unknown[];
  readonly $between?: readonly [number | string | Date, number | string | Date];
  readonly $startsWith?: string;
  readonly $endsWith?: string;
  readonly $contains?: string;
  readonly $regex?: string | RegExp;
  readonly $exists?: boolean;
}

export type DbWhereValue = unknown | DbFieldFilter;

export interface DbQueryOptions {
  readonly where?: Record<string, DbWhereValue>;
  readonly and?: readonly Record<string, DbWhereValue>[];
  readonly or?: readonly Record<string, DbWhereValue>[];
  readonly not?: Record<string, DbWhereValue>;
  readonly limit?: number;
  readonly offset?: number;
  readonly sortBy?: string | readonly string[];
  readonly sortOrder?: "asc" | "desc" | readonly ("asc" | "desc")[];
}

// -------------------------------------------------------------
// Index Definitions & Types
// -------------------------------------------------------------

export type IndexType = "equality" | "sorted" | "composite" | "prefix";

export interface IndexDefinition {
  readonly name: string;
  readonly type: IndexType;
  readonly fields: readonly string[];
  readonly cardinality: number;
  readonly isUnique?: boolean;
}

// -------------------------------------------------------------
// Mutation Options & TTL Expiration
// -------------------------------------------------------------

export interface DbPutOptions {
  readonly ttlMs?: number;
  readonly idempotencyKey?: string;
}

// -------------------------------------------------------------
// Multi-Dimensional Aggregation Pipeline
// -------------------------------------------------------------

export type DbAggregateMetric = "sum" | "avg" | "min" | "max" | "count" | "stddev";

export interface DbAggregateQuery {
  readonly groupBy?: readonly string[];
  readonly metrics: Record<string, { readonly metric: DbAggregateMetric; readonly field?: string }>;
  readonly where?: Record<string, DbWhereValue>;
  readonly having?: Record<string, DbWhereValue>;
  readonly limit?: number;
}

export interface DbGroupResult {
  readonly keys: Record<string, unknown>;
  readonly metrics: Record<string, number>;
  readonly recordCount: number;
}

export interface DbAggregateResult {
  readonly table: string;
  readonly totalRecordsEvaluated: number;
  readonly groups: readonly DbGroupResult[];
  readonly grandTotals: Record<string, number>;
  readonly executionTimeMicros: number;
}

// -------------------------------------------------------------
// Reactive Change Data Capture (CDC) & Observables
// -------------------------------------------------------------

export type TableChangeOperation = "INSERT" | "UPDATE" | "DELETE" | "CLEAR" | "EXPIRE";

export interface TableChangeEvent<T extends Record<string, any> = Record<string, any>> {
  readonly operation: TableChangeOperation;
  readonly table: string;
  readonly recordId: string;
  readonly before?: T;
  readonly after?: T;
  readonly diff?: Record<string, { readonly old?: unknown; readonly new?: unknown }>;
  readonly timestamp: number;
}

export type TableChangeCallback<T extends Record<string, any> = Record<string, any>> = (
  event: TableChangeEvent<T>
) => void;

export interface TableChangeSubscription {
  readonly subscriptionId: string;
  unsubscribe(): void;
}

// -------------------------------------------------------------
// Natural Query Expression & Parsed AST
// -------------------------------------------------------------

export interface NaturalQueryParsed {
  readonly rawText: string;
  readonly targetTable: string;
  readonly queryOptions: DbQueryOptions;
  readonly confidence: number;
  readonly tokensMatched: readonly string[];
}

// -------------------------------------------------------------
// Fluent Query Builder Contract
// -------------------------------------------------------------

export interface ITableTransaction<T extends Record<string, any> = Record<string, any>> {
  get(id: string): T | undefined;
  put(id: string, record: T, options?: DbPutOptions): T;
  delete(id: string): boolean;
  query(options?: DbQueryOptions): readonly T[];
}

export interface IFluentQueryBuilder<T extends Record<string, any> = Record<string, any>> {
  where(field: keyof T & string): IFluentFieldPredicate<T>;
  and(field: keyof T & string): IFluentFieldPredicate<T>;
  or(clause: (builder: IFluentQueryBuilder<T>) => void): IFluentQueryBuilder<T>;
  orderBy(field: keyof T & string, direction?: "asc" | "desc"): IFluentQueryBuilder<T>;
  limit(count: number): IFluentQueryBuilder<T>;
  offset(count: number): IFluentQueryBuilder<T>;
  execute(): readonly T[];
  explain(): QueryExecutionPlan;
  first(): T | undefined;
  count(): number;
}

export interface IFluentFieldPredicate<T extends Record<string, any> = Record<string, any>> {
  equals(value: unknown): IFluentQueryBuilder<T>;
  notEquals(value: unknown): IFluentQueryBuilder<T>;
  greaterThan(value: number | string | Date): IFluentQueryBuilder<T>;
  greaterThanOrEqual(value: number | string | Date): IFluentQueryBuilder<T>;
  lessThan(value: number | string | Date): IFluentQueryBuilder<T>;
  lessThanOrEqual(value: number | string | Date): IFluentQueryBuilder<T>;
  in(values: readonly unknown[]): IFluentQueryBuilder<T>;
  notIn(values: readonly unknown[]): IFluentQueryBuilder<T>;
  between(min: number | string | Date, max: number | string | Date): IFluentQueryBuilder<T>;
  startsWith(prefix: string): IFluentQueryBuilder<T>;
  contains(substring: string): IFluentQueryBuilder<T>;
  matches(regex: string | RegExp): IFluentQueryBuilder<T>;
}

export interface QueryExecutionPlan {
  readonly table: string;
  readonly matchedIndex?: string;
  readonly indexType?: IndexType;
  readonly scanStrategy: "INDEX_LOOKUP" | "INDEX_RANGE_SCAN" | "COMPOSITE_INDEX_LOOKUP" | "PREFIX_SCAN" | "MULTI_INDEX_INTERSECTION" | "FULL_TABLE_SCAN";
  readonly candidatesScanned: number;
  readonly recordsMatched: number;
  readonly executionTimeMicros: number;
  readonly query: DbQueryOptions;
}

// -------------------------------------------------------------
// Master Table Interface
// -------------------------------------------------------------

export interface IDbTable<T extends Record<string, any> = Record<string, any>> {
  readonly name: string;
  get(id: string): T | undefined;
  getAll(): readonly T[];
  put(id: string, record: T, options?: DbPutOptions): T;
  putMany(entries: ReadonlyArray<{ id: string; record: T; options?: DbPutOptions }>): readonly T[];
  compareAndSwap(
    id: string,
    predicate: (current: T | undefined) => boolean,
    updater: (current: T) => T,
    options?: DbPutOptions
  ): { success: boolean; record?: T };
  delete(id: string): boolean;
  deleteWhere(where: Record<string, DbWhereValue>): number;
  updateWhere(where: Record<string, DbWhereValue>, updater: (record: T) => T): number;
  query(options?: DbQueryOptions): readonly T[];
  createIndex(field: keyof T & string): void;
  createSortedIndex(field: keyof T & string): void;
  createCompositeIndex(fields: readonly (keyof T & string)[]): void;
  createPrefixIndex(field: keyof T & string): void;
  aggregate(query: DbAggregateQuery): DbAggregateResult;
  select(): IFluentQueryBuilder<T>;
  subscribe(callback: TableChangeCallback<T>, filter?: (record: T) => boolean): TableChangeSubscription;
  count(): number;
  clear(): void;
  createSnapshot(): Map<string, T>;
  restoreSnapshot(snapshot: Map<string, T>): void;
}

export interface TimelineCheckpointRecord {
  readonly checkpointId: string;
  readonly timestamp: number;
  readonly frameIndex: number;
  readonly label: string;
  readonly tableCount: number;
  readonly totalRecords: number;
  readonly snapshotHash: string;
}

export interface DbHealthReport {
  readonly status: "HEALTHY" | "DEGRADED" | "CORRUPTED";
  readonly timestamp: number;
  readonly pillars: {
    readonly diskInvariants: {
      readonly valid: boolean;
      readonly baseDir: string;
      readonly diskUsageBytes: number;
      readonly writeable: boolean;
    };
    readonly casIntegrity: {
      readonly totalBlobs: number;
      readonly corruptCount: number;
      readonly compressionSavingsPct: number;
      readonly healthy: boolean;
    };
    readonly walJournal: {
      readonly totalFrames: number;
      readonly uncommittedFrames: number;
      readonly lastSyncTimestamp: number;
      readonly healthy: boolean;
    };
    readonly tableConsistency: {
      readonly tableCount: number;
      readonly totalRecords: number;
      readonly indexParity: boolean;
      readonly healthy: boolean;
    };
  };
  readonly actionableRecommendations: readonly string[];
}

export interface IBroccoliDatabaseKernel {
  readonly workspaceRoot: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  flush(): Promise<void>;
  getTable<T extends Record<string, any> = Record<string, any>>(name: string): IDbTable<T>;
  checkpoint(label?: string): Promise<TimelineCheckpointRecord>;
  rollback(checkpointId: string): Promise<boolean>;
  listCheckpoints(): readonly TimelineCheckpointRecord[];
  health(): Promise<DbHealthReport>;
  storeBlob(content: Buffer | string): Promise<string>;
  readBlob(hash: string): Promise<Buffer | null>;
  gc(): Promise<number>;
}

// -------------------------------------------------------------
// Connection Pooling & Distributed Lease Management
// -------------------------------------------------------------

export type BroccoliLeaseMode = "SHARED_READ" | "EXCLUSIVE_WRITE";

export interface BroccoliLeaseHandle {
  readonly leaseId: string;
  readonly clientId: string;
  readonly mode: BroccoliLeaseMode;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  release(): void;
}

export interface BroccoliPoolMetrics {
  readonly totalAcquired: number;
  readonly totalReleased: number;
  readonly activeLeases: number;
  readonly waitingClients: number;
  readonly peakActiveLeases: number;
}

export interface IBroccoliConnectionPool {
  acquire(clientId: string, mode?: BroccoliLeaseMode, timeoutMs?: number): Promise<BroccoliLeaseHandle>;
  withLease<T>(clientId: string, mode: BroccoliLeaseMode, fn: (lease: BroccoliLeaseHandle) => Promise<T>): Promise<T>;
  getMetrics(): BroccoliPoolMetrics;
  drain(): Promise<void>;
}

// -------------------------------------------------------------
// Distributed Lock Authority & Deadlock Immunity
// -------------------------------------------------------------

export type BroccoliLockMode = "SHARED" | "EXCLUSIVE";

export interface BroccoliLockHandle {
  readonly lockId: string;
  readonly resourceKey: string;
  readonly ownerId: string;
  readonly mode: BroccoliLockMode;
  readonly acquiredAt: number;
  readonly expiresAt: number;
}

export interface IBroccoliLockAuthority {
  acquireLock(resourceKey: string, ownerId: string, mode?: BroccoliLockMode, ttlMs?: number): Promise<BroccoliLockHandle>;
  acquireAll(resourceKeys: readonly string[], ownerId: string, mode?: BroccoliLockMode, ttlMs?: number): Promise<readonly BroccoliLockHandle[]>;
  releaseLock(lockId: string): boolean;
  releaseAllForOwner(ownerId: string): number;
  isLocked(resourceKey: string): boolean;
  getActiveLocks(): readonly BroccoliLockHandle[];
}

// -------------------------------------------------------------
// Cost-Based Query Optimizer
// -------------------------------------------------------------

export type BroccoliQueryPlanType = "PRIMARY_KEY_LOOKUP" | "SECONDARY_INDEX_SEEK" | "RANGE_SCAN" | "FULL_TABLE_SCAN";

export interface BroccoliQueryPlan {
  readonly planType: BroccoliQueryPlanType;
  readonly targetTable: string;
  readonly selectedIndex?: string;
  readonly estimatedCost: number;
  readonly explanation: string;
  readonly scanRange?: { readonly min?: unknown; readonly max?: unknown };
}

export interface IBroccoliQueryOptimizer {
  planQuery<T extends Record<string, unknown>>(
    tableName: string,
    filter: Partial<T> | Record<string, unknown>,
    indexNames?: readonly string[]
  ): BroccoliQueryPlan;
}

// -------------------------------------------------------------
// Multi-Version Concurrency Control (MVCC) Snapshot Isolation
// -------------------------------------------------------------

export interface BroccoliRecordVersion<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly recordId: string;
  readonly txId: number;
  readonly deletedTxId?: number;
  readonly createdAt: number;
  readonly isDeleted: boolean;
  readonly data?: T;
}

export interface BroccoliMvccTransaction {
  readonly txId: number;
  readonly startedAt: number;
  readonly isolationLevel: "SNAPSHOT_ISOLATION" | "READ_COMMITTED";
  readonly status: "ACTIVE" | "COMMITTED" | "ROLLED_BACK";
  readonly writtenRecords: readonly { readonly table: string; readonly recordId: string }[];
}

export interface IBroccoliMvccEngine {
  beginTransaction(isolationLevel?: "SNAPSHOT_ISOLATION" | "READ_COMMITTED"): BroccoliMvccTransaction;
  commitTransaction(txId: number): boolean;
  rollbackTransaction(txId: number): boolean;
  readRecord<T extends Record<string, unknown>>(table: string, recordId: string, txId: number): T | undefined;
  writeRecord<T extends Record<string, unknown>>(table: string, recordId: string, data: T, txId: number): void;
  deleteRecord(table: string, recordId: string, txId: number): void;
  vacuum(minActiveTxId?: number): number;
  getActiveTransactions(): readonly BroccoliMvccTransaction[];
}

// -------------------------------------------------------------
// Adaptive Sparse Block Indexing & Bloom Filters
// -------------------------------------------------------------

export interface BroccoliBlockSummary {
  readonly blockIndex: number;
  readonly recordCount: number;
  readonly startId: string;
  readonly endId: string;
  readonly bounds: Record<string, { readonly min: unknown; readonly max: unknown; readonly bloomMask?: bigint }>;
  readonly bloomFilterMask: bigint;
}

export interface BroccoliSparseIndexScanResult {
  readonly totalBlocks: number;
  readonly scannedBlocks: number;
  readonly prunedBlocks: number;
  readonly matchedRecordIds: readonly string[];
}

export interface IBroccoliSparseIndexEngine {
  buildSparseIndex<T extends Record<string, unknown>>(
    tableName: string,
    records: readonly T[],
    indexedColumns?: readonly string[],
    blockSize?: number
  ): readonly BroccoliBlockSummary[];
  pruneBlocks(
    tableName: string,
    filter: Record<string, unknown>
  ): BroccoliSparseIndexScanResult;
}

// -------------------------------------------------------------
// Change Data Capture (CDC) Streams
// -------------------------------------------------------------

export type BroccoliCdcOp = "INSERT" | "UPDATE" | "DELETE" | "TX_COMMIT" | "TX_ROLLBACK";

export interface BroccoliCdcEvent<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly lsn: number;
  readonly timestamp: number;
  readonly table: string;
  readonly op: BroccoliCdcOp;
  readonly recordId: string;
  readonly before?: T;
  readonly after?: T;
  readonly txId?: number;
}

export interface BroccoliCdcFilter {
  readonly tables?: readonly string[];
  readonly ops?: readonly BroccoliCdcOp[];
  readonly fromLsn?: number;
}

export type BroccoliCdcCallback = (event: BroccoliCdcEvent) => void;

export interface BroccoliCdcSubscription {
  readonly subscriptionId: string;
  unsubscribe(): void;
}

export interface IBroccoliCdcStream {
  emitEvent<T extends Record<string, unknown>>(
    table: string,
    op: BroccoliCdcOp,
    recordId: string,
    before?: T,
    after?: T,
    txId?: number
  ): BroccoliCdcEvent<T>;
  subscribe(filter: BroccoliCdcFilter, callback: BroccoliCdcCallback): BroccoliCdcSubscription;
  getEvents(fromLsn?: number, limit?: number): readonly BroccoliCdcEvent[];
  getLatestLsn(): number;
}

// -------------------------------------------------------------
// Vectorized Columnar Execution Engine
// -------------------------------------------------------------

export type BroccoliVectorFilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains";
export type BroccoliVectorAggType = "SUM" | "AVG" | "MIN" | "MAX" | "COUNT";

export interface BroccoliVectorChunk {
  readonly length: number;
  readonly columns: Record<string, Float64Array | Int32Array | readonly (string | null | undefined)[]>;
  readonly nullMasks: Record<string, Uint8Array>;
  readonly recordIds: readonly string[];
}

export interface IBroccoliVectorEngine {
  createVectorChunk<T extends Record<string, unknown>>(
    records: readonly T[],
    numericColumns?: readonly string[],
    stringColumns?: readonly string[]
  ): BroccoliVectorChunk;
  vectorFilter(
    chunk: BroccoliVectorChunk,
    column: string,
    op: BroccoliVectorFilterOp,
    value: unknown,
    selectionVector?: readonly number[]
  ): readonly number[];
  vectorAggregate(
    chunk: BroccoliVectorChunk,
    column: string,
    aggType: BroccoliVectorAggType,
    selectionVector?: readonly number[]
  ): number;
}

// -------------------------------------------------------------
// BM25 Adaptive Inverted Full-Text Search Engine
// -------------------------------------------------------------

export interface TermPostingList {
  readonly term: string;
  readonly docFrequency: number;
  readonly postings: ReadonlyMap<string, { readonly termFrequency: number; readonly positions: readonly number[] }>;
}

export interface Bm25SearchResult {
  readonly docId: string;
  readonly score: number;
  readonly matchedTerms: readonly string[];
}

export interface IBroccoliInvertedIndexEngine {
  indexDocument(table: string, docId: string, text: string, metadata?: Record<string, unknown>): void;
  removeDocument(table: string, docId: string): boolean;
  search(
    table: string,
    query: string,
    limit?: number,
    options?: { readonly k1?: number; readonly b?: number; readonly phrase?: boolean }
  ): readonly Bm25SearchResult[];
  getDocumentCount(table: string): number;
}

// -------------------------------------------------------------
// Distributed Two-Phase Commit (2PC) Coordinator
// -------------------------------------------------------------

export type Broccoli2pcTxState =
  | "PREPARING"
  | "PREPARED"
  | "COMMITTING"
  | "COMMITTED"
  | "ABORTING"
  | "ABORTED"
  | "HEURISTIC";

export interface IBroccoli2pcParticipant {
  readonly participantId: string;
  prepare(txId: string): Promise<boolean>;
  commit(txId: string): Promise<void>;
  rollback(txId: string): Promise<void>;
}

export interface Broccoli2pcTransactionSession {
  readonly txId: string;
  readonly createdAt: number;
  readonly state: Broccoli2pcTxState;
  readonly participants: readonly string[];
  readonly preparedParticipants?: readonly string[];
  readonly failureReason?: string;
}

export interface IBroccoliTwoPhaseCommitCoordinator {
  registerParticipant(participant: IBroccoli2pcParticipant): void;
  unregisterParticipant(participantId: string): void;
  begin2pcTransaction(txId: string, participantIds?: readonly string[]): Broccoli2pcTransactionSession;
  execute2pc(txId: string): Promise<boolean>;
  getTransaction(txId: string): Broccoli2pcTransactionSession | undefined;
  getActiveTransactions(): readonly Broccoli2pcTransactionSession[];
}

// -------------------------------------------------------------
// Adaptive Buffer Pool & LRU-K Page Cache Manager
// -------------------------------------------------------------

export interface BroccoliPageFrame<T = unknown> {
  readonly pageId: string;
  readonly frameId: number;
  data: T;
  isDirty: boolean;
  pinCount: number;
  lastAccessTimestamps: number[]; // K access timestamps for LRU-K
}

export interface BroccoliBufferPoolMetrics {
  readonly totalFrames: number;
  readonly activePages: number;
  readonly pinnedPages: number;
  readonly dirtyPages: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly hitRatioPct: number;
  readonly evictions: number;
}

export interface IBroccoliBufferPoolManager {
  fetchPage<T = unknown>(pageId: string, loader?: (pageId: string) => Promise<T>): Promise<BroccoliPageFrame<T>>;
  unpinPage(pageId: string, isDirty?: boolean): void;
  flushPage(pageId: string, writer?: (pageId: string, data: unknown) => Promise<void>): Promise<boolean>;
  flushAllPages(writer?: (pageId: string, data: unknown) => Promise<void>): Promise<number>;
  getMetrics(): BroccoliBufferPoolMetrics;
  clear(): void;
}

// -------------------------------------------------------------
// Log-Structured Merge-Tree (LSM) Storage Substrate
// -------------------------------------------------------------

export interface BroccoliSsTableMeta {
  readonly tableId: string;
  readonly level: number;
  readonly recordCount: number;
  readonly minKey: string;
  readonly maxKey: string;
  readonly bloomFilterMask: bigint;
  readonly createdAt: number;
  readonly sizeBytes: number;
}

export interface BroccoliLsmCompactionStats {
  readonly compactedTablesCount: number;
  readonly inputRecordsCount: number;
  readonly outputRecordsCount: number;
  readonly purgedTombstonesCount: number;
  readonly durationMs: number;
}

export interface IBroccoliLsmStore {
  put(key: string, value: unknown): void;
  get(key: string): unknown | undefined;
  delete(key: string): boolean;
  scan(startKey?: string, endKey?: string, limit?: number): ReadonlyArray<{ readonly key: string; readonly value: unknown }>;
  flushMemTable(): Promise<BroccoliSsTableMeta | null>;
  compact(level?: number): Promise<BroccoliLsmCompactionStats>;
  getMemTableSize(): number;
  getSsTableMetas(): readonly BroccoliSsTableMeta[];
}

// -------------------------------------------------------------
// Distributed Raft Consensus Substrate
// -------------------------------------------------------------

export type BroccoliRaftNodeRole = "FOLLOWER" | "CANDIDATE" | "LEADER";

export interface BroccoliRaftLogEntry {
  readonly index: number;
  readonly term: number;
  readonly command: string;
  readonly payload?: unknown;
  readonly timestamp: number;
}

export interface BroccoliRaftVoteRequest {
  readonly term: number;
  readonly candidateId: string;
  readonly lastLogIndex: number;
  readonly lastLogTerm: number;
}

export interface BroccoliRaftVoteResponse {
  readonly term: number;
  readonly voteGranted: boolean;
}

export interface BroccoliRaftAppendEntriesRequest {
  readonly term: number;
  readonly leaderId: string;
  readonly prevLogIndex: number;
  readonly prevLogTerm: number;
  readonly entries: readonly BroccoliRaftLogEntry[];
  readonly leaderCommit: number;
}

export interface BroccoliRaftAppendEntriesResponse {
  readonly term: number;
  readonly success: boolean;
  readonly matchIndex: number;
}

export interface IBroccoliRaftConsensusEngine {
  readonly nodeId: string;
  getRole(): BroccoliRaftNodeRole;
  getCurrentTerm(): number;
  getLeaderId(): string | null;
  getCommitIndex(): number;
  requestVote(request: BroccoliRaftVoteRequest): BroccoliRaftVoteResponse;
  appendEntries(request: BroccoliRaftAppendEntriesRequest): BroccoliRaftAppendEntriesResponse;
  proposeCommand(command: string, payload?: unknown): Promise<BroccoliRaftLogEntry>;
  startElection(): Promise<boolean>;
  getLogEntries(fromIndex?: number): readonly BroccoliRaftLogEntry[];
}

// -------------------------------------------------------------
// Adaptive Query Plan Cache
// -------------------------------------------------------------

export interface BroccoliCachedPlan {
  readonly planId: string;
  readonly queryFingerprint: string;
  readonly plan: BroccoliQueryPlan;
  readonly createdAt: number;
  lastUsedAt: number;
  executionCount: number;
  totalExecutionTimeMicros: number;
  averageExecutionTimeMicros: number;
  lastRecordedRowCount?: number;
}

export interface BroccoliPlanCacheMetrics {
  readonly cachedPlansCount: number;
  readonly totalHits: number;
  readonly totalMisses: number;
  readonly hitRatioPct: number;
  readonly invalidationsCount: number;
  readonly driftReoptimizationsCount: number;
}

export interface IBroccoliAdaptivePlanCache {
  getPlan(fingerprint: string): BroccoliCachedPlan | undefined;
  setPlan(fingerprint: string, plan: BroccoliQueryPlan): BroccoliCachedPlan;
  recordExecution(fingerprint: string, executionTimeMicros: number, actualRowCount?: number): void;
  invalidateTable(tableName: string): number;
  clear(): void;
  getMetrics(): BroccoliPlanCacheMetrics;
}

// -------------------------------------------------------------
// Distributed Transaction Sagas & Compensating Workflows
// -------------------------------------------------------------

export type BroccoliSagaStepStatus = "PENDING" | "EXECUTING" | "COMPLETED" | "COMPENSATING" | "COMPENSATED" | "FAILED";

export interface BroccoliSagaStep<TContext = unknown, TResult = unknown> {
  readonly stepName: string;
  execute(context: TContext): Promise<TResult>;
  compensate(context: TContext, result?: TResult): Promise<void>;
}

export type BroccoliSagaState = "PENDING" | "RUNNING" | "COMPLETED" | "COMPENSATING" | "COMPENSATED" | "FAILED";

export interface BroccoliSagaExecutionResult<TContext = unknown> {
  readonly sagaId: string;
  readonly state: BroccoliSagaState;
  readonly context: TContext;
  readonly completedSteps: readonly string[];
  readonly compensatedSteps: readonly string[];
  readonly error?: Error;
  readonly compensationErrors?: readonly { readonly stepName: string; readonly error: Error }[];
  readonly durationMs: number;
}

export interface IBroccoliSagaOrchestrator {
  executeSaga<TContext = any>(
    sagaId: string,
    context: TContext,
    steps: readonly BroccoliSagaStep<TContext, any>[]
  ): Promise<BroccoliSagaExecutionResult<TContext>>;
  getSagaResult(sagaId: string): BroccoliSagaExecutionResult | undefined;
  listSagas(): readonly BroccoliSagaExecutionResult[];
}

// -------------------------------------------------------------
// Multi-Tier Semantic KV Cache with XFetch Early Refresh
// -------------------------------------------------------------

export interface BroccoliTieredCacheEntry<T = unknown> {
  readonly key: string;
  readonly value: T;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly computationTimeMs: number; // delta in XFetch
  readonly tier: "L1_MEMORY" | "L2_COMPRESSED" | "L3_STORAGE";
  readCount: number;
}

export interface BroccoliTieredCacheMetrics {
  readonly l1EntriesCount: number;
  readonly l2EntriesCount: number;
  readonly l3EntriesCount: number;
  readonly l1Hits: number;
  readonly l2Hits: number;
  readonly l3Hits: number;
  readonly misses: number;
  readonly earlyRefreshes: number;
}

export interface IBroccoliTieredKvCache {
  get<T = unknown>(
    key: string,
    fetcher?: () => Promise<T>,
    options?: { readonly ttlMs?: number; readonly beta?: number }
  ): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T, ttlMs?: number): void;
  delete(key: string): boolean;
  clear(): void;
  getMetrics(): BroccoliTieredCacheMetrics;
}

// -------------------------------------------------------------
// Approximate Nearest Neighbor (ANN) Vector Similarity Search
// -------------------------------------------------------------

export type VectorDistanceMetric = "COSINE" | "EUCLIDEAN" | "DOT_PRODUCT";

export interface VectorAnnSearchResult {
  readonly vectorId: string;
  readonly score: number;
  readonly distance: number;
  readonly metadata?: Record<string, unknown>;
}

export interface IBroccoliVectorAnnEngine {
  insertVector(
    namespace: string,
    vectorId: string,
    embedding: Float64Array | Float32Array | readonly number[],
    metadata?: Record<string, unknown>
  ): void;
  deleteVector(namespace: string, vectorId: string): boolean;
  searchNearest(
    namespace: string,
    queryEmbedding: Float64Array | Float32Array | readonly number[],
    topK?: number,
    metric?: VectorDistanceMetric
  ): readonly VectorAnnSearchResult[];
  getVectorCount(namespace: string): number;
}

// -------------------------------------------------------------
// Distributed Consistent Hash Ring & Virtual Nodes
// -------------------------------------------------------------

export interface HashRingNode {
  readonly nodeId: string;
  readonly weight?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface IBroccoliConsistentHashRing {
  addNode(node: HashRingNode): void;
  removeNode(nodeId: string): boolean;
  getNode(key: string): HashRingNode | undefined;
  getNodesForKey(key: string, replicaCount?: number): readonly HashRingNode[];
  getAllNodes(): readonly HashRingNode[];
  getVirtualNodeCount(): number;
}

// -------------------------------------------------------------
// Continuous Time-Series Metric Rollup Engine
// -------------------------------------------------------------

export interface TimeSeriesPoint {
  readonly timestamp: number;
  readonly value: number;
  readonly tags?: Record<string, string>;
}

export interface TimeSeriesWindowAggregation {
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  readonly avg: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
}

export interface IBroccoliTimeSeriesRollupEngine {
  recordPoint(metricName: string, value: number, timestamp?: number, tags?: Record<string, string>): void;
  queryRollup(
    metricName: string,
    windowSizeMs: number,
    startTime: number,
    endTime: number
  ): readonly TimeSeriesWindowAggregation[];
  getMetricNames(): readonly string[];
}

// -------------------------------------------------------------
// Adaptive B-Tree Index Substrate
// -------------------------------------------------------------

export interface BTreeNodeEntry<TValue = unknown> {
  readonly key: string | number;
  readonly value: TValue;
}

export interface IBroccoliBTreeIndexEngine<TValue = unknown> {
  insert(key: string | number, value: TValue): void;
  search(key: string | number): TValue | undefined;
  delete(key: string | number): boolean;
  rangeScan(minKey: string | number, maxKey: string | number): readonly BTreeNodeEntry<TValue>[];
  size(): number;
  clear(): void;
}

// -------------------------------------------------------------
// Distributed Wait-For Graph (WFG) Deadlock Detector
// -------------------------------------------------------------

export interface DeadlockEdge {
  readonly waitingTxId: string;
  readonly holdingTxId: string;
  readonly resourceKey: string;
  readonly timestamp: number;
}

export interface DeadlockDetectionResult {
  readonly hasDeadlock: boolean;
  readonly cycle?: readonly string[];
  readonly victimTxId?: string;
}

export interface IBroccoliDeadlockDetector {
  addWaitFor(waitingTxId: string, holdingTxId: string, resourceKey: string): void;
  removeWaitFor(waitingTxId: string, holdingTxId: string, resourceKey?: string): void;
  removeTx(txId: string): void;
  detectDeadlock(): DeadlockDetectionResult;
  getActiveWaitEdges(): readonly DeadlockEdge[];
}

// -------------------------------------------------------------
// Continuous Incremental Materialized View Substrate
// -------------------------------------------------------------

export type MaterializedViewAggregateFunc = "COUNT" | "SUM" | "AVG" | "MIN" | "MAX";

export interface MaterializedViewDefinition<TRecord extends Record<string, any> = Record<string, any>> {
  readonly viewName: string;
  readonly sourceTable: string;
  readonly groupByField?: Extract<keyof TRecord, string>;
  readonly aggregateField?: Extract<keyof TRecord, string>;
  readonly aggregateFunc?: MaterializedViewAggregateFunc;
  readonly filterPredicate?: (record: TRecord) => boolean;
}

export interface MaterializedViewRow {
  readonly groupKey: string;
  readonly aggregateValue: number;
  readonly rowCount: number;
  readonly lastUpdatedAt: number;
}

export interface IBroccoliMaterializedViewEngine {
  createView<TRecord extends Record<string, any> = Record<string, any>>(
    def: MaterializedViewDefinition<TRecord>
  ): void;
  dropView(viewName: string): boolean;
  applyMutation<TRecord extends Record<string, any> = Record<string, any>>(
    sourceTable: string,
    operation: "INSERT" | "UPDATE" | "DELETE",
    before?: TRecord,
    after?: TRecord
  ): void;
  getViewData(viewName: string): readonly MaterializedViewRow[];
  getViewRow(viewName: string, groupKey: string): MaterializedViewRow | undefined;
  listViews(): readonly string[];
}
