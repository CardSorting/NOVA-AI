import { validModelId } from './capability-registry.js';

export interface DiscoveryShard { id: string; accessToken: string; accountId: string; }
export class CapabilityDiscoveryError extends Error {
  constructor(readonly code: 'invalid_credential' | 'inventory_unavailable' | 'invalid_inventory', readonly status?: number) {
    super(code);
  }
}

/** Inventories establish model access only. They do not establish image-tool support. */
export async function discoverOpenAIModels(shard: DiscoveryShard, signal: AbortSignal,
  transport: typeof fetch = fetch, inventoryUrl?: string): Promise<string[]> {
  const apiKey = shard.accessToken.startsWith('sk-');
  const endpoint = inventoryUrl ?? (apiKey ? 'https://api.openai.com/v1/models'
    : 'https://chatgpt.com/backend-api/codex/models?client_version=0.150.1');
  const response = await transport(endpoint, { signal, redirect: 'error', headers: {
    Authorization: `Bearer ${shard.accessToken}`,
    ...(!apiKey ? { 'ChatGPT-Account-Id': shard.accountId, originator: 'codex_cli_rs' } : {})
  } });
  if (!response.ok) {
    await response.body?.cancel();
    throw new CapabilityDiscoveryError(response.status === 401 ? 'invalid_credential' : 'inventory_unavailable', response.status);
  }
  // Inventory includes provider instructions: bound the read and retain model IDs only.
  const reader = response.body?.getReader();
  if (!reader) throw new CapabilityDiscoveryError('invalid_inventory');
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 8 * 1024 * 1024) throw new CapabilityDiscoveryError('invalid_inventory');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const models = apiKey ? body.data : body.models;
  if (!Array.isArray(models) || models.length > 2000) throw new CapabilityDiscoveryError('invalid_inventory');
  if (models.some(m => !m || !validModelId(apiKey ? m.id : m.slug))) throw new CapabilityDiscoveryError('invalid_inventory');
  const accessible = models.filter(m => apiKey || (m.visibility !== 'hide' && m.supported_in_api !== false));
  const ids: string[] = accessible.filter(m => !apiKey || !/^(gpt-image-|dall-e-)/.test(m.id)).map(m => apiKey ? m.id : m.slug);
  for (const m of accessible) {
    if (apiKey && /^(gpt-image-|dall-e-)/.test(m.id)) ids.push(`image:${m.id}`);
    if (!apiKey && Array.isArray(m.experimental_supported_tools) && m.experimental_supported_tools.includes('image_generation')) ids.push(`image:${m.slug}`);
  }
  return [...new Set(ids)];
}
