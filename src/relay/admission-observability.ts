import type { AdmissionState } from './admission-lifecycle.js';

export const ADMISSION_EVENT_NAMES = [
  'received',
  'candidate_evaluated',
  'candidate_rejected',
  'reselection_started',
  'reservation_attempted',
  'reservation_acquired',
  'reservation_rejected',
  'worker_pregrant_started',
  'worker_pregrant_rejected',
  'dispatch_started',
  'terminal',
] as const;

export type AdmissionEventName = typeof ADMISSION_EVENT_NAMES[number];

export const ADMISSION_EVENT_REASONS = [
  'capability_mismatch',
  'credential_rejected',
  'workload_capacity_unavailable',
  'occupied',
  'cooling_or_quarantined',
  'not_ready',
  'excluded_target',
  'reservation_unavailable',
  'deadline_expired',
  'cancelled',
  'no_compatible_candidate',
  'worker_pregrant_rejected',
  'ambiguous_dispatch',
  'unknown',
] as const;

export type AdmissionEventReason = typeof ADMISSION_EVENT_REASONS[number];

export interface AdmissionEvent {
  readonly at: string;
  readonly requestId: string;
  readonly workload: string;
  readonly name: AdmissionEventName;
  readonly state: AdmissionState;
  readonly targetId?: string;
  readonly reason?: AdmissionEventReason;
  readonly queuePasses: number;
}

export type AdmissionEventInput = Omit<AdmissionEvent, 'at'>;
export type AdmissionEventSink = (event: AdmissionEvent) => void;

const MAX_REQUEST_ID_LENGTH = 128;
const MAX_TARGET_ID_LENGTH = 128;

function bounded(value: string, max: number): string {
  return value.slice(0, max);
}

/**
 * Bounded, private admission evidence. The default sink is the runtime's
 * administrator-owned structured log; it is never returned by an inference
 * route or copied into a public receipt/DTO.
 */
export class AdmissionEventBuffer {
  private readonly events: AdmissionEvent[] = [];

  constructor(
    private readonly maxEvents = 512,
    private readonly sink: AdmissionEventSink = event => {
      try {
        console.warn(JSON.stringify({ event: 'relay_admission', ...event }));
      } catch {
        // Diagnostics must never alter admission or terminal behavior.
      }
    },
  ) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) throw new RangeError('Invalid admission event limit');
  }

  record(input: AdmissionEventInput): void {
    const event: AdmissionEvent = {
      at: new Date().toISOString(),
      requestId: bounded(input.requestId, MAX_REQUEST_ID_LENGTH),
      workload: bounded(input.workload, 32),
      name: input.name,
      state: input.state,
      ...(input.targetId ? { targetId: bounded(input.targetId, MAX_TARGET_ID_LENGTH) } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      queuePasses: Number.isSafeInteger(input.queuePasses) && input.queuePasses >= 0 ? input.queuePasses : 0,
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    try { this.sink(event); } catch {
      // A diagnostic sink failure cannot change request behavior.
    }
  }

  snapshot(): AdmissionEvent[] {
    return this.events.map(event => ({ ...event }));
  }
}
