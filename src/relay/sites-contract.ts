/** Private, administrator-only protocol check. This attests relay behavior;
 * supplier enforcement still requires separate live qualification. */
export interface SitesContractRequest { model: string; maxOutputTokens: number; nonce: string; profile?: 'sites-local-v1'; }
export function sitesContractRequest(query: URLSearchParams): SitesContractRequest {
  const local = query.get('profile') === 'sites-local-v1';
  if ([...query.keys()].sort().join(',') !== (local ? 'maxOutputTokens,model,nonce,profile' : 'maxOutputTokens,model,nonce')) throw new Error('Contract unavailable');
  const model = query.get('model')!, raw = query.get('maxOutputTokens')!, nonce = query.get('nonce')!;
  if (!/^[a-zA-Z0-9_.:-]{1,120}$/.test(model) || !/^[1-9][0-9]{0,5}$/.test(raw) ||
      Number(raw) > 32768 || !/^[a-f0-9-]{36}$/.test(nonce)) throw new Error('Contract unavailable');
  return { model, maxOutputTokens: Number(raw), nonce, ...(local ? { profile: 'sites-local-v1' as const } : {}) };
}
export function sitesContractQuery(request: SitesContractRequest): URLSearchParams {
  const query = new URLSearchParams({ model: request.model, maxOutputTokens: String(request.maxOutputTokens), nonce: request.nonce });
  if (request.profile !== undefined) query.set('profile', request.profile);
  sitesContractRequest(query); return query;
}
export function sitesContractReply(request: SitesContractRequest) {
  if (request.profile === 'sites-local-v1') return {
    version: 2, profile: request.profile, model: request.model, maxOutputTokens: request.maxOutputTokens,
    nonce: request.nonce, maxOutputBytes: 12000, maxWallTimeMs: 30000, maxAttempts: 1,
    durableReceiptVersion: 1, receiptRetentionDays: 30,
  };
  return { version: 1, profile: 'sites-text-v1', model: request.model, maxOutputTokens: request.maxOutputTokens,
    nonce: request.nonce, outputLimitForwarded: true, durableReceiptVersion: 1, receiptRetentionDays: 30 };
}
export async function verifySitesContractResponse(response: Response, request: SitesContractRequest): Promise<void> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw new Error();
    reader = response.body?.getReader(); if (!reader) throw new Error();
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > 4096) throw new Error(); chunks.push(part.value); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const expected = sitesContractReply(request);
    if (!result || Object.keys(result).sort().join(',') !== Object.keys(expected).sort().join(',') ||
        Object.entries(expected).some(([key, value]) => result[key] !== value)) throw new Error();
  } catch { throw new Error('Contract unavailable'); }
  finally { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    else await response.body?.cancel().catch(() => {}); }
}
