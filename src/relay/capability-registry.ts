import { CODEX_IMAGE_ALIAS, IMAGE_TOOL_EVIDENCE_TTL_MS } from './image-compatibility.js';
export type CapabilityState = 'UNKNOWN' | 'AVAILABLE' | 'TEMPORARILY_UNAVAILABLE' | 'NOT_AUTHORIZED' | 'DEGRADED';
export type RelayLifecycle = 'STARTING' | 'DISCOVERING_CAPABILITIES' | 'HEALTHY' | 'CAPABILITY_EMPTY' | 'DRAINING' | 'UNAVAILABLE';
export interface ModelCapability {
  model: string;
  state: CapabilityState;
  observedAtMs: number;
  expiresAtMs: number;
  source: 'inventory' | 'response';
  inventoryBacked?: boolean;
  inventoryVersion?: number;
  version?: number;
  reason?: string;
  executionModel?: string;
  routingMode?: 'codex_image_tool_alias';
  restoreAfterMs?: number;
}
export interface RelayCapabilityRecord {
  shardId: string;
  relayId: string;
  generation: string;
  provider: string;
  lifecycle: RelayLifecycle;
  health: 'healthy' | 'degraded' | 'unavailable';
  activeStreams: number;
  capacity: number;
  latencyMs: number;
  recentErrors: number;
  queueDepth: number;
  lastCapabilityRefreshMs: number;
  heartbeatExpiresAtMs: number;
  capabilityEmptySinceMs?: number;
  models: ModelCapability[];
  revision: number;
  healthRevision: number;
  heartbeatObservedAtMs: number;
}
export interface CapabilityRefreshTicket { shardId: string; generation: string; revision: number; modelVersion?: number; inventoryVersion?: number; modelVersions?: Record<string, number>; refreshSequence?: number; }
export const validModelId = (model: unknown): model is string => typeof model === 'string' && /^[\w.:-]{1,102}$/.test(model);

/** One writer per relay generation. The reverse index contains evidence, never catalog guesses. */
export class CapabilityRegistry {
  private refreshSequence = 0;
  private readonly acceptedRefresh = new Map<string, number>();
  private readonly shards = new Map<string, RelayCapabilityRecord>();
  private readonly byModel = new Map<string, Set<string>>();
  private readonly relayOwners = new Map<string, string>();
  private readonly expectedModels = new Set<string>();
  private readonly admissionPaused = new Set<string>();
  setAdmissionPaused(shardId: string, paused: boolean): void { if (paused) this.admissionPaused.add(shardId); else this.admissionPaused.delete(shardId); }
  constructor(private readonly now: () => number = Date.now, readonly ttlMs = 120000, readonly stabilizationMs = 5000) {
    if (!Number.isFinite(ttlMs) || ttlMs < 1000 || ttlMs > 3600000) throw new Error('Capability TTL must be 1s–1h');
  }
  private write(record: RelayCapabilityRecord): void {
    const old = this.shards.get(record.shardId);
    if (old) for (const model of old.models) this.byModel.get(model.model)?.delete(record.shardId);
    this.shards.set(record.shardId, record);
    this.relayOwners.set(record.relayId, record.shardId);
    for (const model of record.models) {
      this.expectedModels.add(model.model);
      if (model.state !== 'AVAILABLE') continue;
      let ids = this.byModel.get(model.model);
      if (!ids) this.byModel.set(model.model, ids = new Set());
      ids.add(record.shardId);
    }
  }
  register(shardId: string, relayId: string, generation: string, provider: string, capacity = 4): void {
    if (!shardId || !relayId || !generation || !Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid relay ownership');
    const owner = this.relayOwners.get(relayId);
    if (owner && owner !== shardId) throw new Error('Relay already belongs to a different shard');
    const old = this.shards.get(shardId);
    if (old) {
      if (old.relayId !== relayId || old.generation !== generation) throw new Error('Remove old relay ownership before replacement');
      return;
    }
    this.write({ shardId, relayId, generation, provider, lifecycle: 'DISCOVERING_CAPABILITIES', health: 'healthy',
      activeStreams: 0, capacity, latencyMs: 0, recentErrors: 0, queueDepth: 0, lastCapabilityRefreshMs: 0,
      heartbeatExpiresAtMs: this.now() + this.ttlMs, models: [], revision: 0, healthRevision: 0, heartbeatObservedAtMs: this.now() });
  }
  remove(shardId: string, generation?: string): void {
    const old = this.shards.get(shardId);
    if (!old || (generation && old.generation !== generation)) return;
    for (const model of old.models) this.byModel.get(model.model)?.delete(shardId);
    this.relayOwners.delete(old.relayId);
    this.shards.delete(shardId);
    this.acceptedRefresh.delete(shardId);
  }
  beginRefresh(shardId: string): CapabilityRefreshTicket | undefined {
    const shard = this.shards.get(shardId);
    return shard && { shardId, generation: shard.generation, revision: shard.revision, refreshSequence: ++this.refreshSequence,
      modelVersions: Object.fromEntries(shard.models.map(m => [m.model, m.version ?? 0])) };
  }
  beginObservation(shardId: string, model: string): CapabilityRefreshTicket | undefined {
    const shard = this.shards.get(shardId);
    return shard && { shardId, generation: shard.generation, revision: shard.revision, modelVersion: shard.models.find(m => m.model === model)?.version ?? 0,
      inventoryVersion: shard.models.find(m => m.model === model)?.inventoryVersion ?? 0 };
  }
  publishInventory(ticket: CapabilityRefreshTicket, models: string[]): boolean {
    const old = this.shards.get(ticket.shardId);
    if (!old || old.generation !== ticket.generation || (ticket.refreshSequence !== undefined
      ? ticket.refreshSequence <= (this.acceptedRefresh.get(ticket.shardId) ?? 0) : old.revision !== ticket.revision)) return false;
    if (models.length > 2000 || models.some(m => !validModelId(m))) throw new Error('Invalid capability inventory');
    const now = this.now();
    const available = new Set(models);
    const previous = new Map(old.models.map(m => [m.model, m]));
    const next: ModelCapability[] = [...new Set([...available, ...previous.keys()])].map(model => {
      const prior = previous.get(model);
      // Merge unaffected models: busy models must not starve the rest of the inventory.
      if (ticket.modelVersions && (prior?.version ?? 0) !== (Object.hasOwn(ticket.modelVersions, model) ? ticket.modelVersions[model] : 0)) return prior!;
      // Successful operation evidence is distinct from inventory and expires independently.
      if (!available.has(model) && prior?.source === 'response' && !prior.inventoryBacked && prior.expiresAtMs > now) return prior;
      if (available.has(model) && (prior?.restoreAfterMs ?? 0) > now) return prior!;
      return { model, state: available.has(model) ? 'AVAILABLE' : 'NOT_AUTHORIZED', observedAtMs: now,
        expiresAtMs: now + this.ttlMs, source: 'inventory', inventoryBacked: true, inventoryVersion: old.revision + 1, version: old.revision + 1 };
    });
    if (ticket.refreshSequence !== undefined) this.acceptedRefresh.set(ticket.shardId, ticket.refreshSequence);
    const usable = next.some(m => m.state === 'AVAILABLE' && m.expiresAtMs > now);
    this.write({ ...old, models: next, revision: old.revision + 1, lastCapabilityRefreshMs: now,
      lifecycle: old.lifecycle === 'DRAINING' ? 'DRAINING' : usable ? 'HEALTHY' : 'CAPABILITY_EMPTY',
      capabilityEmptySinceMs: usable ? undefined : old.capabilityEmptySinceMs ?? now });
    return true;
  }
  observe(ticket: CapabilityRefreshTicket, model: string, state: CapabilityState, reason?: string, compatibilityAlias = false): boolean {
    const old = this.shards.get(ticket.shardId);
    if (!old || old.generation !== ticket.generation || !validModelId(model)) return false;
    if (compatibilityAlias && model !== `image:${CODEX_IMAGE_ALIAS.requestedModel}`) return false;
    const prior = old.models.find(m => m.model === model);
    const changed = ticket.modelVersion !== undefined ? ticket.modelVersion !== (prior?.version ?? 0) : old.revision !== ticket.revision;
    // A concurrent success cannot suppress a denial within the same inventory epoch.
    // Rediscovery and replacement generations remain authoritative fences for old failures.
    const concurrentDenial = ['NOT_AUTHORIZED', 'TEMPORARILY_UNAVAILABLE'].includes(state) && prior?.source === 'response'
      && prior.state === 'AVAILABLE' && ticket.inventoryVersion !== undefined && ticket.inventoryVersion === (prior.inventoryVersion ?? 0);
    if (changed && !concurrentDenial) return false;
    const now = this.now();
    // A successful older in-flight response must not erase a newer negative observation.
    if (state === 'AVAILABLE' && (prior?.restoreAfterMs ?? 0) > now) return false;
    const models: ModelCapability[] = [...old.models.filter(m => m.model !== model), { model, state,
      observedAtMs: now, expiresAtMs: now + (compatibilityAlias && state === 'AVAILABLE' ? IMAGE_TOOL_EVIDENCE_TTL_MS : this.ttlMs), source: 'response',
      ...(compatibilityAlias ? { executionModel: CODEX_IMAGE_ALIAS.executionModel, routingMode: CODEX_IMAGE_ALIAS.routingMode } : {}), version: old.revision + 1, inventoryBacked: compatibilityAlias ? false : prior?.inventoryBacked, inventoryVersion: prior?.inventoryVersion, reason,
      restoreAfterMs: state === 'AVAILABLE' ? undefined : now + this.stabilizationMs }];
    const usable = models.some(m => m.state === 'AVAILABLE' && m.expiresAtMs > now);
    this.write({ ...old, models, revision: old.revision + 1,
      lifecycle: old.lifecycle === 'DRAINING' ? 'DRAINING' : usable ? 'HEALTHY' : 'CAPABILITY_EMPTY',
      capabilityEmptySinceMs: usable ? undefined : old.capabilityEmptySinceMs ?? now });
    return true;
  }
  /** Accept only the assigned generation; network snapshots cannot claim new ownership. */
  receive(record: RelayCapabilityRecord): boolean {
    const old = this.shards.get(record.shardId);
    if (!old || old.relayId !== record.relayId || old.generation !== record.generation || record.revision < old.revision
      || record.healthRevision <= old.healthRevision) return false;
    if (!Number.isSafeInteger(record.revision) || record.revision < 0 || !Number.isSafeInteger(record.healthRevision) || record.healthRevision < 0
      || !['HEALTHY', 'CAPABILITY_EMPTY', 'DISCOVERING_CAPABILITIES', 'STARTING', 'DRAINING', 'UNAVAILABLE'].includes(record.lifecycle)
      || !['healthy', 'degraded', 'unavailable'].includes(record.health) || !Number.isFinite(record.heartbeatObservedAtMs) || record.heartbeatObservedAtMs > this.now() + 10000 || !Number.isFinite(record.heartbeatExpiresAtMs)
      || record.heartbeatExpiresAtMs > this.now() + 15000 + 10000
      || [record.latencyMs, record.recentErrors, record.queueDepth].some(n => !Number.isFinite(n) || n < 0)) return false;
    if (!Array.isArray(record.models) || record.models.length > 2000 || record.models.some(m => !m || !validModelId(m.model)
      || !['UNKNOWN', 'AVAILABLE', 'TEMPORARILY_UNAVAILABLE', 'NOT_AUTHORIZED', 'DEGRADED'].includes(m.state)
      || !Number.isFinite(m.observedAtMs) || m.observedAtMs > this.now() + 10000 || !Number.isFinite(m.expiresAtMs) || m.expiresAtMs > this.now() + (m.model === `image:${CODEX_IMAGE_ALIAS.requestedModel}` && m.source === 'response' && m.routingMode === CODEX_IMAGE_ALIAS.routingMode && m.executionModel === CODEX_IMAGE_ALIAS.executionModel ? IMAGE_TOOL_EVIDENCE_TTL_MS : this.ttlMs) + 10000)) return false;
    if (!Number.isFinite(record.activeStreams) || record.activeStreams < 0 || !Number.isFinite(record.capacity) || record.capacity < 1) return false;
    this.write(structuredClone(record));
    return true;
  }
  heartbeat(shardId: string, stats: Partial<Pick<RelayCapabilityRecord, 'activeStreams' | 'capacity' | 'latencyMs' | 'recentErrors' | 'queueDepth' | 'health'>>, leaseMs = 15000, advanceRevision = true): void {
    const old = this.shards.get(shardId);
    if (old) this.shards.set(shardId, { ...old, ...stats, heartbeatObservedAtMs: this.now(), healthRevision: old.healthRevision + (advanceRevision ? 1 : 0), heartbeatExpiresAtMs: this.now() + leaseMs });
  }
  drain(shardId: string): void {
    const old = this.shards.get(shardId);
    if (old) this.shards.set(shardId, { ...old, lifecycle: 'DRAINING', revision: old.revision + 1 });
  }
  private eligibleRecords(model: string): RelayCapabilityRecord[] {
    const now = this.now();
    return [...(this.byModel.get(model) ?? [])].flatMap(id => {
      const shard = this.shards.get(id)!;
      const capability = shard.models.find(m => m.model === model);
      const standaloneImage = model === `image:${CODEX_IMAGE_ALIAS.requestedModel}`
        && capability?.routingMode === CODEX_IMAGE_ALIAS.routingMode
        && capability.executionModel === CODEX_IMAGE_ALIAS.executionModel
        && capability.source === 'response';
      return !this.admissionPaused.has(id) && shard.lifecycle === 'HEALTHY' && shard.health === 'healthy' && shard.heartbeatExpiresAtMs > now
        && capability?.state === 'AVAILABLE' && capability.expiresAtMs > now
        && (capability.routingMode === CODEX_IMAGE_ALIAS.routingMode ? standaloneImage && shard.lastCapabilityRefreshMs + this.ttlMs > now
          : !capability.executionModel || shard.models.some(m => m.model === capability.executionModel && m.state === 'AVAILABLE' && m.expiresAtMs > now)) ? [shard] : [];
    });
  }
  eligible(model: string): RelayCapabilityRecord[] { return this.eligibleRecords(model).map(s => structuredClone(s)); }
  eligibleLoad(model: string): Array<Omit<RelayCapabilityRecord, 'models'>> {
    return this.eligibleRecords(model).map(({ models: _models, ...load }) => load);
  }
  eligibleShardIds(model: string): string[] { return this.eligibleRecords(model).map(s => s.shardId); }
  select(model: string, reserved: ReadonlyMap<string, number> = new Map()): RelayCapabilityRecord | undefined {
    const selected = this.eligibleRecords(model).filter(s => Math.max(s.activeStreams + s.queueDepth, reserved.get(s.shardId) ?? 0) < s.capacity)
      .sort((a, b) => a.recentErrors - b.recentErrors
        || Math.max(a.activeStreams, reserved.get(a.shardId) ?? 0) - Math.max(b.activeStreams, reserved.get(b.shardId) ?? 0)
        || a.latencyMs - b.latencyMs || a.queueDepth - b.queueDepth || b.capacity - a.capacity
        || a.shardId.localeCompare(b.shardId))[0];
    return selected && structuredClone(selected);
  }
  get(shardId: string): RelayCapabilityRecord | undefined {
    const value = this.shards.get(shardId);
    return value && structuredClone(value);
  }
  expect(models: string[]): void { for (const model of models) if (validModelId(model)) this.expectedModels.add(model); }
  snapshot() {
    return { shards: [...this.shards.values()].map(s => structuredClone(s)), models: [...this.expectedModels].sort().map(model => {
      const eligible = this.eligibleRecords(model);
      return { model, eligibleShardCount: eligible.length, state: eligible.length === 0 ? 'UNAVAILABLE' : eligible.length === 1 ? 'FRAGILE' : 'HEALTHY',
        redundancy: eligible.length < 2 ? 'NONE' : 'AVAILABLE', shardIds: eligible.map(s => s.shardId),
        activeStreams: eligible.reduce((sum, s) => sum + s.activeStreams, 0), capacity: eligible.reduce((sum, s) => sum + s.capacity, 0) };
    }) };
  }
}

/** Structured model errors only: 429/timeouts/generic 403/404 never prove capability loss. */
export function classifyCapabilityFailure(frame: any): { state: CapabilityState; reason: string } | undefined {
  const error = frame?.error ?? frame?.response?.error ?? frame ?? {};
  const code = String(error.code ?? '').toLowerCase();
  const status = Number(frame?.status ?? frame?.status_code);
  if ([408, 429, 500, 502, 503, 504].includes(status)) return;
  // The standalone Codex image tool has a fixed endpoint contract and does
  // not expose provider text. For that authenticated capability, a 401/403/
  // 404 is sufficient worker-scoped evidence that this account cannot use the
  // image tool. Generic relay HTTP responses remain intentionally neutral.
  if (frame?.source === 'codex_image_tool' && [401, 403, 404].includes(status)) {
    return { state: 'NOT_AUTHORIZED', reason: 'image_tool_access_denied' };
  }
  if (['model_not_allowed', 'model_not_found', 'model_permission_denied', 'model_not_authorized', 'unsupported_model'].includes(code)) {
    return { state: 'NOT_AUTHORIZED', reason: code };
  }
  if (['model_temporarily_unavailable', 'model_unavailable', 'model_disabled'].includes(code)) {
    return { state: 'TEMPORARILY_UNAVAILABLE', reason: code };
  }
  if ([403, 404].includes(status) && /\bmodel\b.{0,80}\b(not available|unavailable|not allowed|not authorized|does not exist|do not have access)\b/i.test(String(error.message ?? ''))) {
    return { state: 'NOT_AUTHORIZED', reason: 'model_access_denied' };
  }
}
