/** Private operator diagnostics. Never serialize provider errors or attach these
 * observations to inference responses, receipts, headers or public job records. */
export interface UpstreamDiagnostic {
  status: number | null;
  code: 'unsupported_parameter' | 'unknown_parameter' | 'invalid_request_error' | 'invalid_value' | 'server_error' | 'unclassified';
  parameter: 'max_output_tokens' | 'reasoning' | 'reasoning.effort' | 'unclassified';
  reason: 'unsupported_parameter' | 'invalid_value' | 'unclassified';
}
export function upstreamDiagnostic(value: unknown): UpstreamDiagnostic {
  const root = value && typeof value === 'object' ? value as Record<string, any> : {};
  const error = root.error ?? root.response?.error ?? {};
  const message = typeof error.message === 'string' ? error.message.slice(0, 8192).toLowerCase() : '';
  const code = ['unsupported_parameter', 'unknown_parameter', 'invalid_request_error', 'invalid_value', 'server_error'].includes(error.code)
    ? error.code : 'unclassified';
  const parameters = ['max_output_tokens', 'reasoning.effort', 'reasoning'] as const;
  const parameter = parameters.find(p => error.param === p || new RegExp(`\\b${p.replace('.', '\\.') }\\b`).test(message)) ?? 'unclassified';
  const status = [root.status, root.status_code, error.status, error.status_code].find(n => Number.isInteger(n) && n >= 400 && n <= 599) ?? null;
  const reason = code === 'unsupported_parameter' || code === 'unknown_parameter' || /unsupported parameter|unknown parameter|unrecognized (?:request )?(?:argument|parameter)|not supported/.test(message)
    ? 'unsupported_parameter' : code === 'invalid_value' || /invalid value|must be (?:at least|greater)|minimum/.test(message) ? 'invalid_value' : 'unclassified';
  return { status, code, parameter, reason };
}
