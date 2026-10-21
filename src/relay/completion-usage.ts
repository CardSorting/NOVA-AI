/** Only transport-level final usage is eligible for settlement. Never estimate
 * from generated text, and never mistake the last retry for the whole job. */
export interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}
export function completionUsage(response: unknown, retries = 0, failovers = 0): CompletionUsage | undefined {
  if (retries !== 0 || failovers !== 0 || !response || typeof response !== 'object') return;
  const r = response as Record<string, any>;
  if (r.status !== 'completed' || !r.usage || typeof r.usage !== 'object') return;
  const { input_tokens: input, output_tokens: output, total_tokens: total } = r.usage;
  if (![input, output, total].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000) ||
      total !== input + output || total === 0) return;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: total };
}

import { functionCalls, type FunctionCall } from './function-tools.js';

export function completionFrame(job: { id: string; usage?: CompletionUsage; outputToolCalls?: FunctionCall[] }): string {
  // Explicit allowlist also protects snapshot replay from extra stored fields.
  const calls = job.outputToolCalls?.length ? functionCalls(job.outputToolCalls) : [];
  const toolFrame = `data: ${JSON.stringify({ id: job.id, object: 'chat.completion.chunk', choices: [{ index: 0,
    delta: calls.length ? { tool_calls: calls.map((c, index) => ({ index, ...c })) } : {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\n`;
  if (!job.usage) return toolFrame;
  const { prompt_tokens, completion_tokens, total_tokens } = job.usage;
  const usage = completionUsage({ status: 'completed', usage: { input_tokens: prompt_tokens, output_tokens: completion_tokens, total_tokens } });
  return toolFrame + (usage ? `data: ${JSON.stringify({ id: job.id, object: 'chat.completion.chunk', choices: [], usage })}\n\n` : '');
}
