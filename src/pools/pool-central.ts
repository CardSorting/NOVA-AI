/** Main-project service. This is the only new component with database account and vault authority. */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { bearer, exactKeys, failure, hash, json, registrationErrors, type PoolId } from './pool-protocol.js';
import { readJsonBody, RequestError } from '../relay/request-policy.js';
import { DesktopCredentialError, parseDesktopCredential, credentialClaims, type DesktopCredential } from './desktop-credentials.js';
import { decryptRegistryShard, encryptRegistryShard } from '../relay/shard-registry.js';
import { createDesktopEnrollment } from './desktop-enrollment.js';
import { createDesktopCredentialRefresh } from './desktop-credential-refresh.js';
import { CapabilityDiscoveryError, discoverOpenAIModels } from '../relay/capability-discovery.js';

type Query = (tokenHash: string, action: string, body: Record<string, any>) => Promise<any>;
export function centralQuery(pool: Pick<Pool, 'query'>): Query {
  return async (token, action, body) => {
    try { return (await pool.query('SELECT private.relay_control($1,$2,$3::jsonb) AS result', [token, action, JSON.stringify(body)])).rows[0].result; }
    catch (error: any) { if(error.code==='GR001')throw new DesktopCredentialError('credential_rejected'); if(error.code==='40001')throw new RequestError(409,'record_changed','This item changed. Refresh before trying again.'); throw new RequestError(error.code === '42501' ? 403 : error.code === 'P0002' ? 404 : ['23505','40001','55P03'].includes(error.code) ? 409 : ['22023','22P02','23502','23514'].includes(error.code) ? 400 : 503, 'action_not_confirmed', 'The action could not be confirmed. Refresh its status before retrying.'); }
  };
}
export function accountClass(candidate: DesktopCredential): 'free' | 'paid' {
  const plan = credentialClaims(candidate.accessToken)['https://api.openai.com/auth']?.chatgpt_plan_type;
  if (plan === 'free') return 'free';
  if (['go','plus','pro','team','business','enterprise','edu'].includes(plan)) return 'paid';
  throw new RequestError(422, 'account_type_unverified', 'The account type could not be verified. Sign in again and retry.');
}
const projectionFields = ['id','desktopId','assignmentRevision','revision','state','credentialRevision','models','expiresAtMs','cooldownUntilMs','connectionState'] as const;
const select = (row: any, fields: readonly string[]) => Object.fromEntries(fields.filter(k => row[k] !== undefined).map(k => [k,row[k]]));
const routes: Record<string, readonly string[]> = {
  '/operator/status': [], '/operator/operation': ['id'], '/operator/prepare': ['id','desktopId','name'],
  '/operator/manage_registration': ['id','registrationId','expectedRevision','command','name'],
  '/operator/ticket': ['id','purpose'], '/operator/set_account': ['id','accountId','expectedRevision','command','name'],
  '/runtime/claim': ['epoch'], '/runtime/heartbeat': ['epoch'], '/runtime/projection': ['epoch'],
  '/runtime/acknowledge': ['epoch','accountId','revision','credentialRevision'],
  '/runtime/credential_failed': ['epoch','accountId','revision','credentialRevision'],
  '/runtime/acquire': ['epoch','accountId','revision','credentialRevision','workload','requestKey','requestSha256','tenantSha256','estimatedTokens'],
  '/runtime/renew': ['epoch','accountId','revision','credentialRevision','leaseId','fencingToken'],
  '/runtime/settle': ['epoch','leaseId','actualTokens','latencyMs','success'],
  '/registrar/review': ['id','ticket','files'], '/registrar/register': ['id','ticket','files'], '/registrar/refresh': ['id','ticket','files'],
  '/registrar/connect': ['id','ticket','files'],
};
export function centralServer(deps: { query: Query; identitySecret: string; decrypt?: typeof decryptRegistryShard; encrypt?: typeof encryptRegistryShard; validate?: (candidate: DesktopCredential) => Promise<string[]> }) {
  const decrypt = deps.decrypt ?? decryptRegistryShard, encrypt = deps.encrypt ?? encryptRegistryShard;
  if (deps.identitySecret.length < 32) throw Error('Central identity secret is required.');
  let active = 0;
  return http.createServer((req,res) => { void (async () => {
    if (req.method === 'GET' && req.url === '/health/live') return json(res,200,{ok:true});
    if (req.headers.origin || req.headers['sec-fetch-site']) throw new RequestError(403,'forbidden','This service requires server authorization.');
    const token = hash(bearer(req)), route = req.url ?? '', fields = routes[route];
    if (req.method !== 'POST' || !fields) throw new RequestError(404,'not_found','Not found.');
    if (active >= 64) throw new RequestError(429,'busy','Try again shortly.');
    active++;
    try {
      const body = await readJsonBody(req, 150000, 10000); exactKeys(body, [...fields,'pool','installationId']);
      const principal = await deps.query(token,'authenticate',body);
      const [kind, action] = route.slice(1).split('/');
      if (principal.kind !== kind && !(kind === 'operator' && principal.kind === 'viewer' && ['status','operation'].includes(action))) throw new RequestError(403,'forbidden','This action requires operator access.');
      if (kind === 'registrar') {
        if (typeof body.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.ticket) || !Array.isArray(body.files)) throw new RequestError(400,'invalid_request','Invalid registration request.');
        const scope = { pool: principal.pool, installationId: principal.installationId, id: body.id, purpose: action, ticketSha256: hash(body.ticket) };
        const context = await deps.query(token,'registration_context',scope);
        if (context.accounts.some((row: any) => !decrypt(row))) throw new RequestError(503,'account_check_unavailable','Existing account identities could not be checked. Retry after the account service is available.');
        const candidate = parseDesktopCredential(body.files);
        // A successful provider request validates this exact token before trusting its claims.
        const models = await (deps.validate ?? (c => discoverOpenAIModels({id:'manual-registration',...c},AbortSignal.timeout(10000))))(candidate);
        const classification = accountClass(candidate);
        if (classification !== 'paid') throw new RequestError(422,'account_type_mismatch','Use a paid account for this registration.');
        const values = { ...scope, fingerprint: candidate.fingerprint, credentialRevision: hash(candidate.accessToken), accountClass: classification,
          models: models.slice(0,512) };
        if (!values.models.length) throw new RequestError(422,'models_unverified','No supported models could be verified.');
        let result: any;
        const common = { read: async () => context.accounts, decrypt, encrypt, validate: async () => models };
        if (action === 'refresh') {
          const refresh = createDesktopCredentialRefresh({ ...common, replace: async (expected, encrypted, expiresAtMs) => {
            result = await deps.query(token,'refresh',{...values,expected,row:{...encrypted,credential_expires_at_ms:expiresAtMs}}); return true;
          } });
          await refresh(context.accountId,candidate,async()=>true,false,{desktopId:context.desktopId,prepare:()=>{}});
          // Even an unchanged token must pass the locked connection-state check.
          result ??= await deps.query(token,'refresh',values);
        } else {
          // The established enrollment matcher rejects duplicate, revoked and mismatched accounts, including legacy rows.
          await createDesktopEnrollment({ ...common, identitySecret:()=>deps.identitySecret + ':central-connections-v1', write: async (_desktop,row,expected) => {
            result = await deps.query(token,action,{...values,row,expected}); return String(row.id);
          } })(context.desktopId,candidate,context.accountId,async()=>true);
        }
        return json(res,200,select(result,['id','desktopId','name','state','accountId','accountClass','models','revision','replayed']));
      }
      if (action === 'ticket') {
        const ticket = randomBytes(32).toString('base64url');
        const result = await deps.query(token,action,{...body,ticketSha256:hash(ticket)});
        return json(res,200,{...select(result,['id','desktopId','name','state']),ticket});
      }
      if (action === 'manage_registration') body.requestSha256 = hash(JSON.stringify(select(body,['id','registrationId','expectedRevision','command','name'])));
      if (action === 'set_account') body.requestSha256 = hash(JSON.stringify(select(body,['id','accountId','expectedRevision','command','name'])));
      const result = await deps.query(token,action,body);
      if (action === 'projection') {
        const accounts = result.accounts.map((a: any) => {
          const metadata = select(a,projectionFields), clear = a.envelope ? decrypt(a.envelope) : null;
          if (a.envelope && (!clear || typeof clear.accessToken !== 'string' || typeof clear.accountId !== 'string')) throw Error('Credential unavailable.');
          return { ...metadata, ...(clear ? {credential:{accessToken:clear.accessToken,accountId:clear.accountId}} : {}) };
        });
        return json(res,200,{pool:result.pool as PoolId,installationId:result.installationId,epoch:result.epoch,executionAllowed:result.executionAllowed,accounts});
      }
      // All other procedure branches construct explicit DTOs in SQL; no table rows are returned.
      return json(res,200,result);
    } finally { active--; }
  })().catch(error => {
    if (error instanceof CapabilityDiscoveryError) error = new DesktopCredentialError(error.code === 'invalid_credential' ? 'credential_rejected' : 'credential_check_unavailable');
    if (error instanceof DesktopCredentialError && Object.hasOwn(registrationErrors,error.code)) {
      const known = registrationErrors[error.code]; error = new RequestError(known.status,error.code,known.message);
    }
    if (!res.headersSent) failure(res,error); else res.destroy();
  }); });
}
