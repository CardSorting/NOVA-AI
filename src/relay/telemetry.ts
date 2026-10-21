import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export type Layer = 'provider' | 'transport' | 'relay' | 'client' | 'unknown';
export type TraceStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'attached';
export interface Span { name: string; layer: Layer; startMs: number; endMs?: number; attempt?: number }
export interface Attempt { number: number; shard: string; startMs: number; endMs?: number; error?: string; layer?: Layer }
export interface Trace {
  id: string; jobId?: string; attachedToJobId?: string; taskId?: string; operation: string; requestedModel?: string; model?: string;
  startedAt: number; durationMs: number; status: TraceStatus; httpStatus?: number; error?: string;
  layer: Layer; firstOutputMs?: number; chunks: number; maxChunkGapMs: number;
  attempts: Attempt[]; spans: Span[]; droppedSpans: number;
}
interface Entry { trace: Trace; origin: number; lastOutput?: number }
// Do not retain arbitrary provider messages, prompts, response bodies, or credentials.
export function safeLabel(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,96}$/.test(value) ? value : undefined;
}
export function classifyFailure(reason = ''): { code: string; layer: Layer } {
  if (/^http_\d{3}$/.test(reason)) return { code: reason, layer: 'client' };
  if (reason === 'relay_memory_pressure' || reason === 'relay_overloaded' || reason === 'relay_rate_limited' || reason === 'relay_retry_budget_exhausted' || reason === 'image_wall_time_exceeded') return { code: reason, layer: 'relay' };
  if (/quota|rate.limit|upstream_http_429/.test(reason)) return { code: 'quota_exhausted', layer: 'provider' };
  if (/unauthorized|upstream_http_40[13]/.test(reason)) return { code: 'credential_rejected', layer: 'provider' };
  if (/upstream_(error|http)|without returning image/.test(reason)) return { code: safeLabel(reason) || 'provider_error', layer: 'provider' };
  if (/client_disconnect|user_cancel/.test(reason)) return { code: 'client_cancelled', layer: 'client' };
  if (/ws_|timeout|timed out|itl_|silence|transport/.test(reason) && !/body|wall_time/.test(reason)) return { code: 'upstream_timeout_or_disconnect', layer: 'transport' };
  if (/shard|registry|drain|wall_time/.test(reason)) return { code: safeLabel(reason) || 'relay_unavailable', layer: 'relay' };
  return { code: 'unclassified_failure', layer: 'unknown' };
}
export class RelayTelemetry {
  private entries = new Map<string, Entry>();
  private jobs = new Map<string, string>();
  readonly capacity = 500;
  readonly retentionMs = 60 * 60 * 1000;
  evicted = 0;
  constructor(private clock = () => performance.now(), private wall = () => Date.now()) {}
  private prune() {
    const now = this.wall();
    for (const [id, e] of this.entries) if (now - e.trace.startedAt > this.retentionMs) this.remove(id);
  }
  private remove(id: string) {
    const e = this.entries.get(id);
    if (e?.trace.jobId && this.jobs.get(e.trace.jobId) === id) this.jobs.delete(e.trace.jobId);
    this.entries.delete(id); this.evicted++;
  }
  private entry(id?: string) { return id ? this.entries.get(this.jobs.get(id) || id) : undefined; }
  private elapsed(e: Entry) { return Math.max(0, this.clock() - e.origin); }
  start(operation: string, taskId?: unknown) {
    this.prune();
    if (this.entries.size >= this.capacity) this.remove(this.entries.keys().next().value!);
    const id = randomUUID();
    this.entries.set(id, { origin: this.clock(), trace: { id, operation, taskId: safeLabel(taskId),
      startedAt: this.wall(), durationMs: 0, status: 'running', layer: 'unknown', chunks: 0,
      maxChunkGapMs: 0, attempts: [], spans: [{ name: 'Request intake', layer: 'relay', startMs: 0 }], droppedSpans: 0 } });
    return id;
  }
  model(id: string | undefined, requested: unknown, actual: unknown) {
    const e = this.entry(id); if (!e) return;
    e.trace.requestedModel = safeLabel(requested); e.trace.model = safeLabel(actual);
  }
  bind(id: string, jobId: string) { const e = this.entry(id); if (e) { e.trace.jobId = jobId; this.jobs.set(jobId, id); } }
  attach(id: string, jobId: string) {
    const e = this.entry(id); if (!e) return;
    e.trace.attachedToJobId = jobId;
    this.phase(id, 'Attach to existing job', 'relay');
    this.finish(id, 'attached');
  }
  phase(id: string | undefined, name: string, layer: Layer) {
    const e = this.entry(id); if (!e || e.trace.status !== 'running') return;
    const now = this.elapsed(e); const last = e.trace.spans.at(-1);
    if (last && last.endMs === undefined) last.endMs = now;
    if (e.trace.spans.length >= 64) { e.trace.droppedSpans++; return; }
    e.trace.spans.push({ name, layer, startMs: now, attempt: e.trace.attempts.at(-1)?.number });
  }
  attempt(id: string | undefined, shardId: string, transport: 'websocket' | 'http' = 'websocket') {
    const e = this.entry(id); if (!e || e.trace.status !== 'running') return;
    if (e.trace.attempts.length >= 16) return;
    e.trace.attempts.push({ number: e.trace.attempts.length + 1, shard: safeLabel(shardId) || 'shard', startMs: this.elapsed(e) });
    e.lastOutput = undefined;
    this.phase(id, transport === 'websocket' ? 'Connect to provider' : 'Provider request (includes network)', 'transport');
  }
  output(id: string) {
    const e = this.entry(id); if (!e || e.trace.status !== 'running') return;
    const now = this.elapsed(e);
    if (e.trace.firstOutputMs === undefined) e.trace.firstOutputMs = now;
    if (e.lastOutput === undefined) this.phase(id, 'Stream output', 'provider');
    else e.trace.maxChunkGapMs = Math.max(e.trace.maxChunkGapMs, now - e.lastOutput);
    e.lastOutput = now; e.trace.chunks++;
  }
  failedAttempt(id: string | undefined, reason: string) {
    const e = this.entry(id); if (!e || e.trace.status !== 'running') return;
    const failure = classifyFailure(reason); const a = e.trace.attempts.at(-1);
    if (a) Object.assign(a, { endMs: this.elapsed(e), error: failure.code, layer: failure.layer });
    this.phase(id, 'Retry / shard selection', 'relay');
  }
  http(id: string, status: number) { const e = this.entry(id); if (e) e.trace.httpStatus = status; }
  finish(id: string, status: TraceStatus, reason?: string, layer?: Layer) {
    const e = this.entry(id); if (!e || e.trace.status !== 'running') return;
    const now = this.elapsed(e); const last = e.trace.spans.at(-1); const attempt = e.trace.attempts.at(-1);
    if (last && last.endMs === undefined) last.endMs = now;
    if (attempt && attempt.endMs === undefined) attempt.endMs = now;
    const failure = reason ? classifyFailure(reason) : undefined;
    Object.assign(e.trace, { status, durationMs: now, error: failure?.code, layer: layer || failure?.layer || 'unknown' });
  }
  snapshot() {
    this.prune();
    return { capturedAt: this.wall(), capacity: this.capacity, retentionMs: this.retentionMs, evicted: this.evicted,
      traces: [...this.entries.values()].reverse().map(e => ({ ...e.trace,
        durationMs: e.trace.status === 'running' ? this.elapsed(e) : e.trace.durationMs,
        attempts: e.trace.attempts.map(a => ({ ...a })), spans: e.trace.spans.map(s => ({ ...s })) })) };
  }
}
