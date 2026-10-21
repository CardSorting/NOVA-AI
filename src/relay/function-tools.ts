/** Client-owned functions only. This module never executes a tool on the relay host. */
export interface FunctionTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}
export interface FunctionCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
const namePattern = /^[A-Za-z0-9_-]{1,64}$/;
const idPattern = /^[A-Za-z0-9_.:-]{1,128}$/;
const object = (v: any): v is Record<string, any> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const invalid = (): never => { throw Error('Invalid function tool contract.'); };

export function functionToolContract(body: Record<string, any>) {
  if (body.functions !== undefined || body.function_call !== undefined) invalid();
  const tools: FunctionTool[] = [];
  const names = new Set<string>();
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 64 || JSON.stringify(body.tools).length > 262144) invalid();
    for (const tool of body.tools) {
      const f = tool?.function;
      if (tool?.type !== 'function' || !object(f) || typeof f.name !== 'string' || !namePattern.test(f.name) || names.has(f.name)
        || !object(f.parameters) || f.parameters.type !== 'object'
        || f.description !== undefined && (typeof f.description !== 'string' || f.description.length > 8192)
        || f.strict !== undefined && typeof f.strict !== 'boolean') invalid();
      names.add(f.name);
      tools.push({ type: 'function', name: f.name, parameters: f.parameters, strict: f.strict ?? false,
        ...(f.description !== undefined ? { description: f.description } : {}),
      });
    }
  }
  let toolChoice: 'auto' | 'none' | 'required' | { type: 'function'; name: string } | undefined;
  if (body.tool_choice !== undefined) {
    if (!tools.length) invalid();
    if (['auto', 'none', 'required'].includes(body.tool_choice)) toolChoice = body.tool_choice;
    else if (body.tool_choice?.type === 'function' && names.has(body.tool_choice.function?.name))
      toolChoice = { type: 'function', name: body.tool_choice.function.name };
    else invalid();
  } else if (tools.length) toolChoice = 'auto';
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') invalid();
  return { tools, toolChoice, ...(body.parallel_tool_calls !== undefined ? { parallelToolCalls: body.parallel_tool_calls } : {}) };
}

/** Validate/rebuild complete calls, including replayed engine results. No nested object forwarding. */
export function functionCalls(value: unknown): FunctionCall[] {
  if (!Array.isArray(value) || value.length > 32 || JSON.stringify(value).length > 524288) invalid();
  const ids = new Set<string>();
  return (value as any[]).map(c => {
    if (!object(c) || c.type !== 'function' || typeof c.id !== 'string' || !idPattern.test(c.id) || ids.has(c.id)
      || !object(c.function) || typeof c.function.name !== 'string' || !namePattern.test(c.function.name)
      || typeof c.function.arguments !== 'string' || c.function.arguments.length > 262144) invalid();
    ids.add(c.id);
    return { id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments } };
  });
}

/** Results keep their call identity; they never become user instructions. */
export function functionInput(messages: Record<string, any>[]) {
  const pending = new Set<string>(), seen = new Set<string>();
  const input: Record<string, any>[] = [];
  let instructions = '';
  for (const m of messages) {
    if (m.role === 'tool') {
      if (typeof m.content !== 'string' || !pending.delete(m.tool_call_id)) invalid();
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content });
      continue;
    }
    if (pending.size) invalid();
    if (m.tool_calls !== undefined && m.role !== 'assistant') invalid();
    const calls = m.tool_calls === undefined ? [] : functionCalls(m.tool_calls);
    if (m.content === null && !calls.length) invalid();
    const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content)
      ? m.content.map((c: any) => typeof c === 'string' ? c : c?.text || JSON.stringify(c)).join('\n') : '';
    if (m.role === 'system' || m.role === 'developer') instructions += `${instructions ? '\n\n' : ''}${text}`;
    else if (text) input.push({ type: 'message', role: m.role, content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text }] });
    for (const c of calls) {
      if (seen.has(c.id)) invalid();
      seen.add(c.id); pending.add(c.id);
      input.push({ type: 'function_call', call_id: c.id, name: c.function.name, arguments: c.function.arguments });
    }
  }
  if (pending.size) invalid();
  return { input, instructions };
}

export function completedFunctionCalls(response: any, contract?: ReturnType<typeof functionToolContract>): FunctionCall[] {
  const output = Array.isArray(response?.output) ? response.output : [];
  if (output.some((x: any) => !['message', 'reasoning', 'function_call'].includes(x?.type))) invalid();
  const calls = functionCalls(output.filter((x: any) => x?.type === 'function_call').map((x: any) => ({
    id: x.call_id, type: 'function', function: { name: x.name, arguments: x.arguments },
  })));
  if (calls.length && (response?.status !== 'completed' || contract?.toolChoice === 'none'
    || calls.some(c => !contract?.tools.some(t => t.name === c.function.name))
    || typeof contract?.toolChoice === 'object' && calls.some(c => c.function.name !== (contract.toolChoice as {name:string}).name))) invalid();
  return calls;
}
