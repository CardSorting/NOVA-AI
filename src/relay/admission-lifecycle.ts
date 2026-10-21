import { performance } from 'node:perf_hooks';

export const ADMISSION_STATES = [
  'received',
  'queued',
  'admitted',
  'dispatched',
  'completed',
  'cancelled',
  'timed_out',
  'rejected',
  'failed',
] as const;

export type AdmissionState = typeof ADMISSION_STATES[number];
export type AdmissionTerminalState = Exclude<AdmissionState, 'received' | 'queued' | 'admitted' | 'dispatched'>;
export type DispatchOutcome = 'not_dispatched' | 'ambiguous' | 'resolved';

export interface AdmissionReservation {
  release(): void;
}

export interface AdmissionSnapshot {
  readonly state: AdmissionState;
  readonly dispatchOutcome: DispatchOutcome;
  readonly deadlineAtMs?: number;
  readonly queuePasses: number;
  readonly clientDisconnected: boolean;
  readonly cleanedUp: boolean;
}

/**
 * The single request-side authority for pool admission.
 *
 * The scheduler owns queue accounting and the reservation owns local capacity.
 * This object owns the request's lifecycle and is the only place that may
 * release that reservation. It intentionally has no I/O or retry behavior.
 */
export class AdmissionLifecycle {
  private currentState: AdmissionState = 'received';
  private dispatchResult: DispatchOutcome = 'not_dispatched';
  private reservation?: AdmissionReservation;
  private released = false;
  private deadlineAt?: number;
  private passes = 0;
  private disconnected = false;

  constructor(
    readonly requestId: string,
    readonly owner: string,
    readonly workload: string,
    private readonly now: () => number = () => performance.now(),
  ) {
    if (!requestId || !owner || !workload) throw new TypeError('Admission identity is required');
  }

  get state(): AdmissionState { return this.currentState; }
  get dispatchOutcome(): DispatchOutcome { return this.dispatchResult; }
  get isTerminal(): boolean { return isTerminalAdmissionState(this.currentState); }
  get deadlineAtMs(): number | undefined { return this.deadlineAt; }
  get queuePasses(): number { return this.passes; }
  get clientDisconnectObserved(): boolean { return this.disconnected; }

  /** Set once. A revalidation can shorten the remaining wait, never reset it. */
  setDeadline(deadlineAtMs: number): void {
    if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= 0) throw new RangeError('Invalid admission deadline');
    if (this.deadlineAt !== undefined && this.deadlineAt !== deadlineAtMs) {
      throw new Error('Admission deadline cannot be reset');
    }
    if (this.isTerminal) throw new Error('Admission is already terminal');
    this.deadlineAt = deadlineAtMs;
  }

  remainingWaitMs(): number | undefined {
    return this.deadlineAt === undefined ? undefined : Math.max(0, Math.ceil(this.deadlineAt - this.now()));
  }

  /** Enter or remain in the bounded queue. */
  queue(): boolean {
    if (this.isTerminal || this.currentState === 'dispatched') return false;
    if (this.expired()) {
      this.timeout();
      return false;
    }
    if (this.currentState === 'admitted') throw new Error('An admitted request cannot return to the queue');
    this.currentState = 'queued';
    this.passes++;
    return true;
  }

  /**
   * Attach the scheduler reservation synchronously after its candidate check.
   * JavaScript runs this call without an await, so no other request can steal
   * the selected slot between reserve() and this state transition.
   */
  admit(reservation: AdmissionReservation): boolean {
    if (this.isTerminal || this.currentState === 'dispatched' || this.currentState === 'completed') {
      reservation.release();
      return false;
    }
    if (this.currentState !== 'received' && this.currentState !== 'queued') {
      reservation.release();
      throw new Error('Admission can only be acquired from received or queued');
    }
    if (this.disconnected) {
      reservation.release();
      this.cancel();
      return false;
    }
    if (this.expired()) {
      reservation.release();
      this.timeout();
      return false;
    }
    if (this.reservation && !this.released) {
      reservation.release();
      throw new Error('Admission already owns a reservation');
    }
    this.reservation = reservation;
    this.released = false;
    this.currentState = 'admitted';
    return true;
  }

  /** Mark the exact boundary at which a mutation may have reached the worker. */
  beginDispatch(): boolean {
    if (this.currentState !== 'admitted' || this.disconnected || this.expired()) {
      if (this.currentState === 'admitted' && this.disconnected) this.cancel();
      else if (this.currentState === 'admitted' && this.expired()) this.timeout();
      return false;
    }
    this.currentState = 'dispatched';
    this.dispatchResult = 'ambiguous';
    return true;
  }

  /** A complete worker response makes the dispatch outcome known. */
  resolveDispatch(): void {
    if (this.currentState !== 'dispatched') throw new Error('Only a dispatched request can resolve');
    this.dispatchResult = 'resolved';
  }

  /**
   * Return one admitted request to bounded selection after its worker
   * authoritatively rejected the work before generation. This is a target
   * handoff, not a new request lifecycle or a replay of an ambiguous POST.
   */
  handoffAfterTargetRejection(): boolean {
    if (this.currentState !== 'dispatched' || this.dispatchResult !== 'resolved' || this.isTerminal) return false;
    if (this.disconnected) {
      this.cancel();
      return false;
    }
    if (this.expired()) {
      this.timeout();
      return false;
    }
    this.cleanup();
    this.currentState = 'queued';
    return true;
  }

  complete(): boolean { return this.terminate('completed'); }
  cancel(): boolean { return this.terminate('cancelled'); }
  timeout(): boolean { return this.terminate('timed_out'); }
  reject(): boolean { return this.terminate('rejected'); }
  fail(): boolean { return this.terminate('failed'); }

  /**
   * Disconnect cancels only before dispatch. Once a POST may have reached the
   * worker, the worker result owns the terminal outcome and must not be replayed.
   */
  clientDisconnected(): void {
    this.disconnected = true;
    if (this.currentState !== 'dispatched' && !this.isTerminal) this.cancel();
  }

  /** Safe to retry only when no worker mutation could have started. */
  get knownNotDispatched(): boolean {
    return this.dispatchResult === 'not_dispatched' && this.currentState !== 'dispatched' && this.currentState !== 'completed';
  }

  /** Idempotent finalizer used by route cleanup and terminal transitions. */
  cleanup(): void {
    if (this.released) return;
    this.released = true;
    this.reservation?.release();
    this.reservation = undefined;
  }

  snapshot(): AdmissionSnapshot {
    return {
      state: this.currentState,
      dispatchOutcome: this.dispatchResult,
      ...(this.deadlineAt === undefined ? {} : { deadlineAtMs: this.deadlineAt }),
      queuePasses: this.passes,
      clientDisconnected: this.disconnected,
      cleanedUp: this.released,
    };
  }

  private expired(): boolean {
    return this.deadlineAt !== undefined && this.now() >= this.deadlineAt;
  }

  private terminate(state: AdmissionTerminalState): boolean {
    if (this.isTerminal) return false;
    this.currentState = state;
    this.cleanup();
    return true;
  }
}

export function isTerminalAdmissionState(state: AdmissionState): state is AdmissionTerminalState {
  return state === 'completed' || state === 'cancelled' || state === 'timed_out' || state === 'rejected' || state === 'failed';
}
