export { BroccoliQueue } from './queue.js';
export type { JobProcessor } from './queue.js';
export type {
  AddJob,
  BackoffOptions,
  BroccoliDatabase,
  BroccoliTable,
  BroccoliQueryOptions,
  Job,
  JobError,
  JobOptions,
  JobQuery,
  JobState,
  JsonValue,
  QueueOptions,
  QueueHealth,
  QueueStateCounts,
  QueueSummary,
  RetryResult,
  WorkerContext,
  WorkerHandle,
  WorkerOptions
} from './types.js';

export const states = Object.freeze({
  waiting: 'waiting',
  delayed: 'delayed',
  active: 'active',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled'
});
