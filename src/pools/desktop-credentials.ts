import { createHash } from 'node:crypto';

export type CredentialSource = 'codex' | 'manual';
export interface DesktopCredentialFile { source: CredentialSource; modifiedAt: number; data: unknown }
export interface DesktopCredential {
  source: CredentialSource; accessToken: string; refreshToken?: string; accountId: string;
  expiresAtMs: number; issuedAtMs: number; fingerprint: string;
}
export class DesktopCredentialError extends Error {
  constructor(readonly code: 'credential_missing' | 'credential_invalid' | 'credential_expired' | 'credential_account_mismatch'
    | 'credential_older' | 'credential_rejected' | 'credential_check_unavailable' | 'credential_registry_unavailable'
    | 'credential_conflict' | 'credential_not_allowed' | 'credential_superseded' | 'credential_checkpoint_unavailable'
    | 'credential_account_unregistered' | 'credential_account_ambiguous') { super(code); }
}
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\s\u0000-\u001f]/.test(value) ? value : undefined;
export function credentialClaims(token: string) {
  try {
    const parts = token.split('.'); if (parts.length !== 3) return {};
    return object(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
  } catch { return {}; }
}
/** Parse fixed login formats. JWT fields are consistency hints; the upstream checks the token before any write. */
export function parseDesktopCredential(files: DesktopCredentialFile[], now = Date.now()): DesktopCredential {
  if (!files.length) throw new DesktopCredentialError('credential_missing');
  if (files.length > 2) throw new DesktopCredentialError('credential_invalid');
  const file = files.slice().sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
  if (!['codex', 'manual'].includes(file.source) || !Number.isFinite(file.modifiedAt)) throw new DesktopCredentialError('credential_invalid');
  const data = object(file.data), tokens = file.source === 'codex' ? object(data.tokens) : data;
  const accessToken = text(file.source === 'codex' ? tokens.access_token : tokens.accessToken, 32768);
  if (!accessToken) throw new DesktopCredentialError('credential_invalid');
  const claims = credentialClaims(accessToken), auth = object(claims['https://api.openai.com/auth']);
  const claimedAccount = text(auth.chatgpt_account_id || claims.chatgpt_account_id, 256);
  const accountId = text(file.source === 'codex' ? tokens.account_id : tokens.accountId, 256) || claimedAccount;
  // This bridge refreshes an existing OAuth account. API-key enrollment is a separate operation.
  if (!claimedAccount || !accountId || claimedAccount !== accountId) throw new DesktopCredentialError('credential_account_mismatch');
  const expiresAtMs = claims.exp * 1000, issuedAtMs = claims.iat * 1000;
  if (!Number.isSafeInteger(expiresAtMs) || !Number.isSafeInteger(issuedAtMs) || issuedAtMs <= 0 || issuedAtMs > now + 60000 || expiresAtMs <= issuedAtMs) throw new DesktopCredentialError('credential_invalid');
  if (expiresAtMs <= now + 60000) throw new DesktopCredentialError('credential_expired');
  const rawRefresh = file.source === 'codex' ? tokens.refresh_token : tokens.refreshToken;
  const refreshToken = rawRefresh == null ? undefined : text(rawRefresh, 32768);
  if (rawRefresh != null && !refreshToken) throw new DesktopCredentialError('credential_invalid');
  return { source: file.source, accountId, accessToken, refreshToken, expiresAtMs, issuedAtMs,
    fingerprint: createHash('sha256').update(JSON.stringify([accountId, accessToken, refreshToken])).digest('hex') };
}
