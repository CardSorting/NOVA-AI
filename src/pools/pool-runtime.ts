import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { once } from 'node:events';
import { GalxaiRelayServer } from '../relay/relay-server.js';
import { PoolExecution, type AssignedAccount, type ExecutionRecord } from './pool-execution.js';
import { bearer, equalSecret, failure, hash, json, requestWorkload, type Workload } from './pool-protocol.js';
import { RequestError, readJsonBody } from '../relay/request-policy.js';
import { decodeImageBase64, sanitizeImageArtifact } from '../security/image-artifact.js';
import { CODEX_IMAGE_ALIAS } from '../relay/image-compatibility.js';
import { publicJob, publicUsage, boundedJson } from './pool-public-response.js';
import { sitesContractRequest, sitesContractReply } from '../relay/sites-contract.js';
import {
  IMAGE_QUEUE_MAX_DEPTH,
  IMAGE_QUEUE_MAX_PER_OWNER,
  IMAGE_QUEUE_MAX_WAIT_MS,
  IMAGE_QUEUE_RECHECK_MS,
  SchedulerQueueError,
  PoolScheduler,
} from './pool-scheduler.js';
import { functionCalls } from '../relay/function-tools.js';
import { RequestBulkhead } from '../relay/request-bulkhead.js';
import { AdmissionLifecycle } from '../relay/admission-lifecycle.js';
import { AdmissionEventBuffer, type AdmissionEventName, type AdmissionEventReason } from '../relay/admission-observability.js';
import {
  decodePrivateRelayFailure,
  MAX_PRIVATE_RETRY_AFTER_MS,
  privateRelayFailure,
  retryAfterSeconds,
  PRIVATE_RELAY_FAILURE_HEADER,
  type PrivateRelayFailure,
} from '../relay/private-failure.js';
import { PoolRequestQueue, type QueuedGenerationRequest, type QueuedHttpResponse } from './pool-request-queue.js';
import { asIncomingMessage, asServerResponse, QueueIncomingMessage, QueueServerResponse, serializeQueueResponse, writeQueueResponse } from './pool-queue-http.js';

interface WorkerCircuit {
  consecutiveFailures: number;
  openUntilMs: number;
  lastClass?: PrivateRelayFailure['class'];
}

type Worker = {
  account:AssignedAccount;
  engine:GalxaiRelayServer;
  key:string;
  port:number;
  /** Per-worker, per-workload circuit state. Never part of public DTOs. */
  failureCircuits?: Partial<Record<Workload, WorkerCircuit>>;
};

const WORKER_CIRCUIT_MAX_MS = MAX_PRIVATE_RETRY_AFTER_MS;
const GENERATION_ERROR_MESSAGES:Readonly<Record<string,string>>={
  service_unavailable:'This service is temporarily unavailable.',
  service_busy:'This service is busy. Try again shortly.',
  busy:'Try again shortly.',
  request_key_required:'Supply an Idempotency-Key.',
  request_in_progress:'Check the existing request.',
  idempotency_conflict:'This request key was already used.',
  result_unconfirmed:'The original result is unavailable. Do not repeat this request.',
  capability_unavailable:'This request requires an unavailable capability.',
  context_budget_exceeded:'Shorten this conversation before continuing.',
  output_budget_exceeded:'Choose an output limit between 1 and 16384 tokens.',
  relay_fleet_unavailable:'The request could not be completed. Check its status before retrying.',
  request_unavailable:'Check the existing request before continuing.',
};

class QueueAdmissionDeadlineError extends RequestError {
  constructor() { super(503, 'service_busy', 'This service is busy. Try again shortly.', 'not_accepted', true); }
}

export class PoolRuntime {
  readonly server: http.Server;
  private workers = new Map<string,Worker>();
  private refreshedAt = 0; private stopped = false; private draining = false; private timer?: NodeJS.Timeout;
  private syncing?: Promise<void>; private pending = new Set<string>();
  private stopPromise?: Promise<void>;
  private readonly scheduler = new PoolScheduler();
  private readonly submissions = new RequestBulkhead();
  private readonly observations = new RequestBulkhead();
  private readonly streams = new RequestBulkhead(64,8);
  private requestQueue?: PoolRequestQueue;
  private ready(queuedWork = false) {
    const age=Date.now()-this.refreshedAt;
    const queueReady=!this.requestQueue || this.requestQueue.healthy || queuedWork && this.draining;
    return !this.stopped && (!this.draining || queuedWork) && queueReady && age>=0 && age<20000 && [...this.workers.values()].some(w=>!w.engine.credentialRejected());
  }
  private workerCircuit(worker: Worker, workload: Workload): WorkerCircuit | undefined {
    return worker.failureCircuits?.[workload];
  }
  private workerCircuitOpen(worker: Worker, workload: Workload, now = Date.now()): boolean {
    const circuit = this.workerCircuit(worker, workload);
    return Boolean(circuit && circuit.openUntilMs > now);
  }
  private noteWorkerFailure(worker: Worker, workload: Workload, failure: PrivateRelayFailure): void {
    // An unknown/ambiguous outcome is terminal for the current mutation, but
    // it does not prove that this worker lacks future capacity. Keep it out of
    // worker cooldown state so one ambiguous request cannot remove an
    // otherwise usable target from the next request's candidate set.
    if (failure.scope !== 'worker' || failure.class === 'unknown') return;
    const circuits = worker.failureCircuits ??= {};
    const previous = circuits[workload];
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    const fallback = failure.class === 'capability_denied' ? 120_000
      : failure.class === 'capability_temporarily_unavailable' ? 30_000
        : failure.class === 'pre_generation_rejected' || failure.class === 'rate_limited' ? 30_000
          : failure.class === 'upstream_timeout' ? 10_000
            : failure.class === 'invalid_upstream_response' ? 30_000
              : 5_000;
    const exponential = Math.min(WORKER_CIRCUIT_MAX_MS, fallback * 2 ** Math.min(4, consecutiveFailures - 1));
    const retryAfterMs = Math.min(WORKER_CIRCUIT_MAX_MS, Math.max(failure.retryAfterMs ?? 0, exponential));
    circuits[workload] = {
      consecutiveFailures,
      openUntilMs: Date.now() + retryAfterMs,
      lastClass: failure.class,
    };
  }
  private clearWorkerFailure(worker: Worker, workload: Workload): void {
    const circuit = this.workerCircuit(worker, workload);
    // A newer quarantine observed while this request was already executing
    // belongs to the worker, not to this older success. Let its cooldown
    // expire or be explicitly replaced before future eligibility changes.
    if (circuit && circuit.openUntilMs > Date.now()) return;
    if (worker.failureCircuits) delete worker.failureCircuits[workload];
  }
  constructor(
    readonly execution: PoolExecution,
    private readonly inferenceKey: string,
    private readonly stateDirectory: string,
    private readonly capabilityKey?: string,
    private readonly admissionEvents = new AdmissionEventBuffer(),
  ) {
    this.server = http.createServer((req,res)=>void this.route(req,res).catch(error=>{ if (!res.headersSent) failure(res,error); else res.destroy(); }));
    this.server.requestTimeout=15000; this.server.maxHeadersCount=40;
  }
  private observeAdmission(admission: AdmissionLifecycle, name: AdmissionEventName, targetId?: string, reason?: AdmissionEventReason): void {
    this.admissionEvents.record({ requestId: admission.requestId, workload: admission.workload, name, state: admission.state,
      ...(targetId ? { targetId } : {}), ...(reason ? { reason } : {}), queuePasses: admission.queuePasses });
  }
  private terminalAdmissionReason(admission: AdmissionLifecycle): AdmissionEventReason | undefined {
    if (admission.state === 'cancelled') return 'cancelled';
    if (admission.state === 'timed_out') return 'deadline_expired';
    if (admission.dispatchOutcome === 'ambiguous') return 'ambiguous_dispatch';
    if (admission.state === 'rejected') return 'no_compatible_candidate';
    if (admission.state === 'failed') return 'unknown';
    return undefined;
  }
  async start(port=3001, host='0.0.0.0') {
    try {
      await this.execution.store.call('identity');
      await this.execution.central.call('/runtime/claim',{epoch:this.execution.epoch});
      await this.execution.store.call('recover',{epoch:this.execution.epoch});
      await this.sync();
      this.requestQueue=await PoolRequestQueue.open(this.stateDirectory,(request,signal)=>this.executeQueuedRequest(request,signal));
      await this.requestQueue.startWorkers();
      const schedule=()=>{ if (this.stopped||this.draining) return; this.timer=setTimeout(async()=>{
        this.timer=undefined;
        if(this.stopped||this.draining)return;
        await this.sync().catch(()=>{this.refreshedAt=0;});schedule();
      },10000);this.timer.unref();}; schedule();
      this.server.listen(port,host); await once(this.server,'listening');
    } catch (error) {
      clearTimeout(this.timer);
      const failures: unknown[]=[];
      if(this.server.listening) await new Promise<void>(resolve=>this.server.close(()=>resolve())).catch(reason=>failures.push(reason));
      const queue=this.requestQueue;
      this.requestQueue=undefined;
      const cleanup=await Promise.allSettled([
        ...(queue?[queue.close()]:[]),
      ]);
      failures.push(...cleanup.flatMap(result=>result.status==='rejected'?[result.reason]:[]));
      const engineCleanup=await Promise.allSettled([...this.workers.values()].map(worker=>worker.engine.stop()));
      failures.push(...engineCleanup.flatMap(result=>result.status==='rejected'?[result.reason]:[]));
      this.workers.clear();
      this.execution.stop();
      await this.execution.settlePending().catch(reason=>failures.push(reason));
      if(failures.length) throw new AggregateError([error,...failures],'Premium runtime startup and cleanup failed');
      throw error;
    }
  }
  private async executeQueuedRequest(request:QueuedGenerationRequest,signal:AbortSignal):Promise<QueuedHttpResponse> {
    const inbound=new QueueIncomingMessage(request.pathname,{
      'x-galx-tenant':request.delegated,
      'idempotency-key':request.idempotencyKey,
    },request.body);
    const outbound=new QueueServerResponse();
    const req=asIncomingMessage(inbound),res=asServerResponse(outbound);
    try {
      await this.route(req,res,{signal,...(request.deadlineAtEpochMs===undefined?{}:{deadlineAtEpochMs:request.deadlineAtEpochMs})});
    } catch (error) {
      if (!outbound.headersSent && error instanceof QueueAdmissionDeadlineError) {
        res.setHeader('retry-after','5');
        res.setHeader('x-should-retry','true');
        json(res,503,{error:{code:'service_busy',message:'This service is busy. Try again shortly.',execution_state:'not_accepted'}});
      } else if (!outbound.headersSent) failure(res,error);
      else outbound.destroy();
    }
    if (!outbound.headersSent) {
      outbound.setHeader('x-should-retry',signal.aborted?'true':'false');
      failure(res,new RequestError(503,'request_unavailable','Check the existing request before continuing.'));
    }
    return serializeQueueResponse(outbound);
  }
  private async publicQueuedResponse(pathname:string,requestBody:Record<string,any>,response:QueuedHttpResponse):Promise<QueuedHttpResponse> {
    const safeFailure=():QueuedHttpResponse=>({status:503,headers:{'content-type':'application/json','cache-control':'no-store',
      'x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-should-retry':'false'},
      body:JSON.stringify({error:{code:'request_unavailable',message:'Check the existing request before continuing.',execution_state:'unknown'}}),encoding:'utf8'});
    if(response.status>=400) {
      let value:any;try{value=JSON.parse(response.body);}catch{return safeFailure();}
      const code=typeof value?.error?.code==='string'&&Object.hasOwn(GENERATION_ERROR_MESSAGES,value.error.code)?value.error.code:'request_unavailable';
      const executionState=['not_accepted','unknown','failed'].includes(value?.error?.execution_state)?value.error.execution_state:'unknown';
      return {...response,headers:{...response.headers,'content-type':'application/json'},
        body:JSON.stringify({error:{code,message:GENERATION_ERROR_MESSAGES[code]??GENERATION_ERROR_MESSAGES.request_unavailable,execution_state:executionState}}),encoding:'utf8'};
    }
    try {
      if(pathname==='/v1/images/generations') {
        if(response.encoding==='base64'&&['image/png','image/jpeg','image/webp'].includes(response.headers['content-type']??'')) {
          const artifact=await sanitizeImageArtifact(Buffer.from(response.body,'base64'));
          return {...response,headers:{...response.headers,'content-type':artifact.contentType},body:artifact.bytes.toString('base64'),encoding:'base64'};
        }
        if(response.encoding!=='utf8'||response.headers['content-type']!=='application/json'||requestBody.response_format!=='b64_json') return safeFailure();
        const value=JSON.parse(response.body),encoded=value?.data?.[0]?.b64_json;
        if(!Number.isSafeInteger(value?.created)||value.created<0||typeof encoded!=='string') return safeFailure();
        const artifact=await sanitizeImageArtifact(decodeImageBase64(encoded));
        return {...response,body:JSON.stringify({created:value.created,data:[{b64_json:artifact.bytes.toString('base64')}]}),encoding:'utf8'};
      }
      if(response.encoding!=='utf8'||response.headers['content-type']!=='application/json') return safeFailure();
      const safe=publicJob(JSON.parse(response.body));
      return {...response,body:JSON.stringify(safe),encoding:'utf8'};
    } catch {
      return safeFailure();
    }
  }
  async sync() {
    if (this.syncing) return this.syncing;
    this.syncing=this.reconcile().finally(()=>{this.syncing=undefined;}); return this.syncing;
  }
  private async reconcile() {
    const central=this.execution.central;
    await central.call('/runtime/heartbeat',{epoch:this.execution.epoch});
    for (const worker of this.workers.values()) {
      if (worker.engine.credentialRejected()) await central.call('/runtime/credential_failed', {
        epoch:this.execution.epoch,accountId:worker.account.id,revision:worker.account.revision,credentialRevision:worker.account.credentialRevision,
      });
    }
    const projection=await central.call('/runtime/projection',{epoch:this.execution.epoch});
    if (projection.pool!==central.identity.pool || projection.installationId!==central.identity.installationId || projection.epoch!==this.execution.epoch || !Array.isArray(projection.accounts) || projection.accounts.length>128) throw Error('Invalid projection.');
    const next=new Map<string,AssignedAccount>(projection.accounts.map((a:AssignedAccount)=>[a.id,a]));
    this.scheduler.reconcile(new Set(next.keys())); this.execution.reconcileAccounts(new Set(next.keys()));
    for (const [id,worker] of this.workers) {
      const a=next.get(id);
      if (!projection.executionAllowed || !a?.credential || a.state!=='enabled' || a.revision!==worker.account.revision || a.credentialRevision!==worker.account.credentialRevision || a.expiresAtMs<=Date.now()+30000) {
        this.workers.delete(id); await worker.engine.stop();
      } else worker.account=a; // Cooldown and capability observations can change without a control revision.
    }
    for (const a of next.values()) {
      if (!/^codex_sh_[a-f0-9]{24}$/.test(a.id) || !Number.isSafeInteger(a.revision) || !/^[a-f0-9]{64}$/.test(a.credentialRevision)) throw Error('Invalid account projection.');
      if (projection.executionAllowed && a.credential && a.state==='enabled' && a.expiresAtMs>Date.now()+30000 && !this.workers.has(a.id)) {
        const key=randomBytes(32).toString('base64url');
        const engine=new GalxaiRelayServer({assignedShardId:a.id,assignedShard:{id:a.id,...a.credential},
          executionPolicy:this.execution.policy(a),host:'127.0.0.1',port:0,apiKeys:[key],adminApiKeys:[randomBytes(32).toString('base64url')],
          registryEnabled:false,discoverHostCredentials:false,masterSecret:undefined,shardsJsonPath:undefined,testOnlyMultiShard:false,
          relayId:central.identity.installationId,generation:this.execution.epoch,allowedOrigins:[],maxUpstreamRetries:0,
          codexImageToolAlias:true,forwardOutputTokenLimit:false,drainTimeoutMs:100,
          // Container logs are private operator evidence, never inference DTOs.
          onUpstreamDiagnostic:(d,context)=>console.warn(JSON.stringify({event:'relay_upstream_rejected',
            pool:central.identity.pool,jobId:context.jobId,status:d.status,code:d.code,parameter:d.parameter,reason:d.reason})),
          shardConcurrency:4,
          stateSnapshotPath:path.join(this.stateDirectory,a.id,'relay.json')});
        try { await engine.start(); this.workers.set(a.id,{account:a,engine,key,port:engine.listeningPort(),failureCircuits:{}}); }
        catch { await engine.stop().catch(()=>{}); throw Error('Worker unavailable.'); }
      }
      // Disabled accounts are acknowledged only once the old engine is stopped. Enabled accounts require a running engine.
      if ((a.state!=='enabled' || !a.credential) && !this.workers.has(a.id) || this.workers.get(a.id)?.account.revision===a.revision) {
        await central.call('/runtime/acknowledge',{epoch:this.execution.epoch,accountId:a.id,revision:a.revision,credentialRevision:a.credentialRevision});
      }
    }
    this.refreshedAt=Date.now(); await this.execution.settlePending();
  }
  private async route(req:http.IncomingMessage,res:http.ServerResponse,queueExecution?:{signal:AbortSignal;deadlineAtEpochMs?:number}) {
    const pathname=new URL(req.url ?? '/','http://local').pathname;
    const internalQueuedGeneration=Boolean(queueExecution && req.method==='POST' && ['/v1/chat/completions','/v1/images/generations'].includes(pathname));
    const ready=this.ready(internalQueuedGeneration);
    if (req.method==='GET' && ['/health/live','/health/ready','/health'].includes(pathname)) return json(res,pathname==='/health/ready'&&!ready?503:200,{ok:pathname==='/health/ready'?ready:true});
    if (pathname==='/api/sites/contract' && req.method==='GET') {
      if(req.headers.origin || !this.capabilityKey || !equalSecret(bearer(req),this.capabilityKey))throw new RequestError(401,'unauthorized','Provide valid authorization.');
      const requested=sitesContractRequest(new URL(req.url!,'http://local').searchParams);
      if(requested.profile!=='sites-local-v1')throw new RequestError(503,'capability_unavailable','This request requires an unavailable capability.');
      if(!ready||![...this.workers.values()].some(w=>w.account.models.includes(requested.model)))throw new RequestError(503,'service_unavailable','This service is temporarily unavailable.');
      return json(res,200,sitesContractReply(requested));
    }
    if (!internalQueuedGeneration && (req.headers.origin || !equalSecret(bearer(req),this.inferenceKey))) throw new RequestError(401,'unauthorized','Provide valid authorization.');
    if(pathname==='/v1/images/availability' && req.method==='GET') {
      const model = new URL(req.url ?? '/', 'http://local').searchParams.get('model');
      if (!model || !/^[a-zA-Z0-9._:-]{1,128}$/.test(model)) throw new RequestError(400, 'invalid_request', 'Specify a valid image model.');
      let available:boolean|null=false;
      if(ready) {
        const checks=[...this.workers.values()]
          .filter(w=>!this.workerCircuitOpen(w,'images'))
          .map(w=>w.engine.imageAvailability());
        // An open worker circuit is temporary evidence, not proof that the
        // account permanently lacks image capability.
        available=checks.length===0?null:checks.includes(true)?true:checks.includes(null)?null:false;
      }
      return json(res,200,{available});
    }
    const delegated=req.headers['x-galx-tenant'];
    if (typeof delegated!=='string' || !/^[a-f0-9]{64}$/.test(delegated)) throw new RequestError(400,'invalid_request','Invalid request identity.');
    const tenantSha256=hash(delegated);
    if (pathname==='/v1/models' && req.method==='GET') {
      if (!ready) throw new RequestError(503,'service_unavailable','This service is temporarily unavailable.');
      const models=[...new Set([...this.workers.values()].filter(w=>!w.engine.credentialRejected()).flatMap(w=>w.account.models).filter(m=>!m.startsWith('image:')))];
      return json(res,200,{object:'list',data:models.map(id=>({id,object:'model',owned_by:'galx'}))});
    }
    const generation=req.method==='POST' && ['/v1/chat/completions','/v1/images/generations'].includes(pathname);
    const job=/^\/v1\/jobs\/([\w-]{1,96})(?:\/(stream|receipt|cancel))?$/.exec(pathname);
    if (!generation && !(job && (req.method==='GET' || req.method==='POST' && job[2]==='cancel'))) throw new RequestError(404,'not_found','Not found.');
    let worker:Worker|undefined, body:Record<string,any>|undefined, lock:string|undefined, workload:Workload|undefined;
    const attemptedWorkerIds = new Set<string>();
    let admission:AdmissionLifecycle|undefined, ownsLock=false;
    let releaseRequest: (() => void) | undefined;
    let releaseStream: (() => void) | undefined;
    const queueAbort = generation ? new AbortController() : undefined;
    const queueSignalAbort = () => { queueAbort?.abort(); if (queueExecution) req.aborted = true; };
    let reselectWorker: (() => Promise<Worker | undefined>) | undefined;
    const abortQueueWait = () => {
      admission?.clientDisconnected();
      queueAbort?.abort();
    };
    if (queueAbort) {
      req.once('aborted', abortQueueWait);
      res.once('close', abortQueueWait);
      if (queueExecution?.signal.aborted) queueSignalAbort();
      else queueExecution?.signal.addEventListener('abort', queueSignalAbort, { once: true });
    }
    let provenNew = false;
    try {
      // Bound body parsing and dependency lookups before allocating their buffers/queries.
      // Recovery reads/cancel have a separate allowance from new submissions.
      if (!internalQueuedGeneration) releaseRequest = (generation ? this.submissions : this.observations).reserve(tenantSha256);
      else releaseRequest = () => {};
      if (!releaseRequest) {
        res.setHeader('Retry-After','5');
        throw new RequestError(503,'service_busy','This service is busy. Try again shortly.');
      }
      if (job?.[2] === 'stream') {
        releaseStream = this.streams.reserve(tenantSha256);
        if (!releaseStream) { res.setHeader('Retry-After','5'); throw new RequestError(503,'service_busy','This service is busy. Try again shortly.'); }
      }
      if (generation) {
        body=await readJsonBody(req,1024*1024,10000); workload=requestWorkload(this.execution.central.identity.pool,pathname,body);
        if (!ready) throw new RequestError(503,'service_unavailable','This service is temporarily unavailable.');
        const key=req.headers['idempotency-key'];
        if (typeof key!=='string'||!/^[\x21-\x7e]{1,128}$/.test(key)) throw new RequestError(400,'request_key_required','Supply an Idempotency-Key.');
        lock=hash(JSON.stringify([tenantSha256,workload,key]));
        admission=new AdmissionLifecycle(lock,tenantSha256,workload);
        this.observeAdmission(admission, 'received');
        if (!internalQueuedGeneration) {
          if (this.pending.has(lock)) throw new RequestError(409,'request_in_progress','Check the existing request.');
          if (this.pending.size>=128) throw new RequestError(429,'busy','Try again shortly.');
          this.pending.add(lock); ownsLock=true;
        }
        const previous:ExecutionRecord|null=await this.execution.store.call('lookup',{requestKey:lock,tenantSha256});
        // Lookup can outlive the caller or the projection. Do not spend a new grant
        // for abandoned work, or use a readiness decision made before this await.
        if (req.aborted || res.destroyed) { admission.clientDisconnected(); return; }
        if (previous) {
          if (previous.requestSha256!==hash(JSON.stringify(body))) throw new RequestError(409,'idempotency_conflict','This request key was already used.');
          if (previous.epoch!==this.execution.epoch || previous.workload==='images' || !this.workers.has(previous.accountId)) throw new RequestError(409,'result_unconfirmed','The original result is unavailable. Do not repeat this request.');
          admission.reject();
          return json(res,202,{id:previous.executionId,status:previous.state==='running'?'running':previous.state==='completed'?'completed':'failed',statusUrl:`/v1/jobs/${previous.executionId}`,streamUrl:`/v1/jobs/${previous.executionId}/stream`});
        }
        provenNew = true;
        const queuedNonStreamingRequest=this.requestQueue && !(pathname==='/v1/chat/completions' && body.stream===true);
        const deadlineAtEpochMs=queueExecution?.deadlineAtEpochMs ?? (workload==='images' || queuedNonStreamingRequest ? Date.now()+IMAGE_QUEUE_MAX_WAIT_MS : undefined);
        if (deadlineAtEpochMs!==undefined) admission.setDeadline(performance.now()+Math.max(0,deadlineAtEpochMs-Date.now()));
        if (body.require_output_limit === true) throw new RequestError(400,'capability_unavailable','This request requires an unavailable capability.');
        if (workload === 'text') {
          if (Buffer.byteLength(JSON.stringify({messages:body.messages,tools:body.tools})) > 262144)
            throw new RequestError(400,'context_budget_exceeded','Shorten this conversation before continuing.');
          if (body.max_tokens !== undefined && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 16384))
            throw new RequestError(400,'output_budget_exceeded','Choose an output limit between 1 and 16384 tokens.');
        }
        if (!this.ready(internalQueuedGeneration)) {
          if(internalQueuedGeneration)throw new QueueAdmissionDeadlineError();
          throw new RequestError(503,'service_unavailable','This service is temporarily unavailable.');
        }
        const model=body.model ?? 'gpt-5.6-terra'; const capability=workload==='images'?`image:${model}`:model;
        if (!internalQueuedGeneration && this.requestQueue && !(pathname==='/v1/chat/completions' && body.stream===true)) {
          if(!admission.queue())throw new QueueAdmissionDeadlineError();
          const idempotencyKey=req.headers['idempotency-key'] as string;
          const queuedRequestBase= {
            pathname:pathname as QueuedGenerationRequest['pathname'], body, delegated,
            idempotencyKey, requestKey:lock!, owner:tenantSha256, workload,
            ...(deadlineAtEpochMs===undefined?{}:{deadlineAtEpochMs}),
          };
          const queuedRequest:QueuedGenerationRequest={...queuedRequestBase,fingerprint:hash(JSON.stringify({
            pathname:queuedRequestBase.pathname,body:queuedRequestBase.body,delegated:queuedRequestBase.delegated,
            idempotencyKey:queuedRequestBase.idempotencyKey,owner:queuedRequestBase.owner,workload:queuedRequestBase.workload,
          }))};
          let queueJob;
          try {
            if (!this.requestQueue.healthy) throw new RequestError(503,'service_unavailable','This service is temporarily unavailable.');
            queueJob=await this.requestQueue.enqueue(queuedRequest);
          } catch (error) {
            if ((error as {code?:string})?.code==='idempotency_conflict') throw new RequestError(409,'idempotency_conflict','This request key was already used.');
            if ((error as {code?:string})?.code==='queue_full') { res.setHeader('Retry-After','5'); throw new RequestError(429,'busy','Try again shortly.','not_accepted',true); }
            if ((error as {code?:string})?.code==='queue_unavailable') throw new RequestError(503,'service_unavailable','This service is temporarily unavailable.','not_accepted',true);
            throw error;
          }
          const disconnect=()=>!req.aborted&&!res.destroyed;
          const result=await this.requestQueue!.waitForResult(queueJob.id,disconnect);
          if (!result) return;
          if (result.status>=200 && result.status<300) admission.complete(); else admission.fail();
          writeQueueResponse(res,await this.publicQueuedResponse(pathname,body,result));
          this.requestQueue.acknowledge(queueJob.id);
          return;
        }
        const generationAdmission = admission;
        reselectWorker = async (): Promise<Worker | undefined> => {
          for (;;) {
            if (!generationAdmission.queue()) {
              if(generationAdmission.state==='timed_out') throw new QueueAdmissionDeadlineError();
              return;
            }
            if (attemptedWorkerIds.size) this.observeAdmission(generationAdmission, 'reselection_started', undefined, 'excluded_target');
            if (!this.ready(internalQueuedGeneration)) throw new RequestError(503,'service_unavailable','This service is temporarily unavailable.','not_accepted',true);
            const now=Date.now();
            const candidates=[...this.workers.values()].filter(w=>{
              this.observeAdmission(generationAdmission, 'candidate_evaluated', w.account.id);
              const reason: AdmissionEventReason | undefined = attemptedWorkerIds.has(w.account.id) ? 'excluded_target'
                : w.engine.credentialRejected() ? 'credential_rejected'
                  : this.workerCircuitOpen(w,workload!,now) ? 'cooling_or_quarantined'
                    : (w.account.models.includes(capability) || workload==='images' && model===CODEX_IMAGE_ALIAS.requestedModel)
                      ? undefined : 'capability_mismatch';
              if (reason) this.observeAdmission(generationAdmission, 'candidate_rejected', w.account.id, reason);
              return !reason;
            });
            const states=candidates.flatMap(w=>{
              if (w.account.expiresAtMs<=now+30000) {
                this.observeAdmission(generationAdmission, 'candidate_rejected', w.account.id, 'not_ready');
                return [];
              }
              if ((w.account.cooldownUntilMs??0)>now) {
                this.observeAdmission(generationAdmission, 'candidate_rejected', w.account.id, 'cooling_or_quarantined');
                return [];
              }
              if (!this.execution.accountAvailable(w.account.id,now)) {
                this.observeAdmission(generationAdmission, 'candidate_rejected', w.account.id, 'workload_capacity_unavailable');
                return [];
              }
              const state=w.engine.accountAvailability(capability, workload==='images' && model===CODEX_IMAGE_ALIAS.requestedModel);
              return [{worker:w,state}];
            });
            for (const {worker:w,state} of states) if (!state.eligible) {
              const reason: AdmissionEventReason = state.availableSlots===0 ? 'occupied' : state.recovering ? 'cooling_or_quarantined' : 'not_ready';
              this.observeAdmission(generationAdmission, 'candidate_rejected', w.account.id, reason);
            }
            const eligible=states.filter(({state})=>state.eligible).map(({worker:w,state})=>({
              id:w.account.id,lastUsedAtMs:state.lastUsedAtMs,
              // Image POSTs are single-flight per worker/shard. Text and Sites
              // retain their independently advertised capacity.
              availableSlots:workload==='images'?Math.min(1,state.availableSlots):state.availableSlots,
              recovering:state.recovering||this.execution.accountRecovering(w.account.id),worker:w,
            }));
            const selection=this.scheduler.reserve(eligible,workload);
            const reservationReason: AdmissionEventReason | undefined = selection ? undefined : eligible.length ? 'occupied' : 'reservation_unavailable';
            this.observeAdmission(generationAdmission, 'reservation_attempted', selection?.candidate.worker.account.id, reservationReason);
            if (selection && generationAdmission.admit(selection)) {
              this.observeAdmission(generationAdmission, 'reservation_acquired', selection.candidate.worker.account.id);
              return selection.candidate.worker;
            }
            if (selection) this.observeAdmission(generationAdmission, 'reservation_rejected', selection.candidate.worker.account.id,
              generationAdmission.state === 'cancelled' ? 'cancelled' : generationAdmission.state === 'timed_out' ? 'deadline_expired' : 'reservation_unavailable');
            if (generationAdmission.isTerminal) return;

            // Queue only while a known image-capable worker is capacity-blocked.
            // Capability loss, cooldowns and worker circuits fail this attempt
            // normally instead of turning a systemic defect into a long wait.
            const imageCapacityBlocked=workload==='images' && (eligible.length>0 || states.some(({state})=>state.availableSlots===0));
            if (!imageCapacityBlocked) {
              this.observeAdmission(generationAdmission, 'candidate_rejected', undefined, 'no_compatible_candidate');
              res.setHeader('Retry-After','5');
              throw new RequestError(503,'service_busy','This service is busy. Try again shortly.','not_accepted',true);
            }
            const remainingQueueMs=generationAdmission.remainingWaitMs() ?? IMAGE_QUEUE_MAX_WAIT_MS;
            if (remainingQueueMs<1) {
              res.setHeader('Retry-After','5');
              throw new RequestError(503,'service_busy','This service is busy. Try again shortly.','not_accepted',true);
            }
            try {
              await this.scheduler.waitForAvailability('images',tenantSha256,{
                maxWaitMs:Math.min(IMAGE_QUEUE_MAX_WAIT_MS,remainingQueueMs),maxQueueDepth:IMAGE_QUEUE_MAX_DEPTH,maxOwnerDepth:IMAGE_QUEUE_MAX_PER_OWNER,
                recheckMs:IMAGE_QUEUE_RECHECK_MS,
                signal:queueAbort?.signal,
              });
            } catch (error) {
              if (error instanceof SchedulerQueueError && error.reason==='cancelled' && (req.aborted || res.destroyed)) {
                generationAdmission.cancel();
                return;
              }
              if (error instanceof SchedulerQueueError && error.reason==='timeout') generationAdmission.timeout();
              else if (error instanceof SchedulerQueueError && error.reason==='full') generationAdmission.reject();
              res.setHeader('Retry-After','5');
              throw new RequestError(error instanceof SchedulerQueueError && error.reason==='full'?429:503,'service_busy','This service is busy. Try again shortly.','not_accepted',true);
            }
            if (req.aborted || res.destroyed) { generationAdmission.clientDisconnected(); return; }
          }
        };
        worker=await reselectWorker();
        if (!worker) return;
      } else {
        const saved:ExecutionRecord|null=await this.execution.store.call('lookup',{executionId:job![1],tenantSha256});
        if (!saved) throw new RequestError(404,'not_found','Request not found.');
        if (saved.epoch!==this.execution.epoch) throw new RequestError(409,'result_unconfirmed','The original result is unavailable. Do not repeat this request.');
        workload=saved.workload;
        worker=this.workers.get(saved.accountId);
      }
      for (;;) {
        if (!worker) {
          admission?.reject();
          throw new RequestError(503,'service_unavailable','This service is temporarily unavailable.');
        }
        if (admission && !admission.beginDispatch()) {
          this.observeAdmission(admission, 'reservation_rejected', worker.account.id,
            admission.state === 'cancelled' ? 'cancelled' : admission.state === 'timed_out' ? 'deadline_expired' : 'reservation_unavailable');
          if(req.aborted||res.destroyed)return;
          throw admission.state==='timed_out'?new QueueAdmissionDeadlineError()
            :new RequestError(503,'service_unavailable','This service is temporarily unavailable.','not_accepted',true);
        }
        attemptedWorkerIds.add(worker.account.id);
        if (admission) {
          this.observeAdmission(admission, 'dispatch_started', worker.account.id);
          this.observeAdmission(admission, 'worker_pregrant_started', worker.account.id);
        }
        let response:Response;
        try {
          response=await fetch(`http://127.0.0.1:${worker.port}${pathname}`,{method:req.method,redirect:'error',signal:queueExecution ? AbortSignal.any([AbortSignal.timeout(310000),queueExecution.signal]) : AbortSignal.timeout(310000),
            headers:{Authorization:`Bearer ${worker.key}`,'Content-Type':'application/json','x-galx-tenant':delegated,
              ...(typeof req.headers['idempotency-key']==='string'?{'idempotency-key':req.headers['idempotency-key']}:{}),
              ...(typeof req.headers['last-event-id']==='string'?{'last-event-id':req.headers['last-event-id']}: {})},body:body?JSON.stringify(body):req.method==='POST'?'{}':undefined});
        } catch {
          const observed=privateRelayFailure({class:'worker_unavailable',scope:'worker',retryAfterMs:5000});
          this.noteWorkerFailure(worker,workload ?? 'text',observed);
          res.setHeader('Retry-After',String(retryAfterSeconds(observed)));
          throw new RequestError(503,'request_unavailable','The request could not be completed. Check its status before retrying.');
        }
        admission?.resolveDispatch();
        if (!response.ok) {
          const observed=decodePrivateRelayFailure(response.headers.get(PRIVATE_RELAY_FAILURE_HEADER))
            ?? (workload === 'images' ? privateRelayFailure({class:'unknown',scope:'worker',retryAfterMs:5000}) : undefined);
          await response.body?.cancel();
          if (observed) {
            this.noteWorkerFailure(worker,workload ?? 'text',observed);
            const canFailover = workload === 'images'
              && observed.scope === 'worker'
              && observed.class === 'pre_generation_rejected';
            if (canFailover && admission) this.observeAdmission(admission, 'worker_pregrant_rejected', worker.account.id, 'worker_pregrant_rejected');
            if (canFailover && admission?.handoffAfterTargetRejection()) {
              worker = await reselectWorker?.();
              if (!worker) return;
              // The admission object remains authoritative. Its handoff
              // released A's reservation and preserved the original deadline;
              // the outer selection loop revalidates B before dispatch.
              continue;
            }
            const retry=retryAfterSeconds(observed); if (retry) res.setHeader('Retry-After',String(retry));
            const code=observed.scope==='fleet' ? 'relay_fleet_unavailable' : 'request_unavailable';
            admission?.fail();
            throw new RequestError([400,403,404,409,429].includes(response.status)?response.status:503,code,'The request could not be completed. Check its status before retrying.');
          }
          admission?.fail();
          throw new RequestError([400,403,404,409,429].includes(response.status)?response.status:503,'request_unavailable','The request could not be completed. Check its status before retrying.');
        }
        if (workload) this.clearWorkerFailure(worker,workload);
        if (response.headers.get('content-type')?.includes('text/event-stream')) {
          releaseRequest?.(); releaseRequest=undefined;
          await this.stream(response,res);
          admission?.complete();
          return;
        }
        const data=await boundedJson(response,pathname.includes('/images/')?32*1024*1024:18*1024*1024);
        if (pathname.includes('/images/')) {
          const artifact=await sanitizeImageArtifact(Buffer.from(data.data?.[0]?.b64_json ?? '','base64'));
          if (body?.response_format==='b64_json') { json(res,200,{created:Math.floor(Date.now()/1000),data:[{b64_json:artifact.bytes.toString('base64')}]}); admission?.complete(); return; }
          res.writeHead(200,{'Content-Type':artifact.contentType,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(artifact.bytes);admission?.complete();return;
        }
        json(res,response.status,publicJob(data)); admission?.complete(); return;
      }
    } catch (error) {
      if (admission && !admission.isTerminal) admission.fail();
      if (!generation || res.headersSent) throw error;
      const state = provenNew && admission?.knownNotDispatched ? 'not_accepted' : 'unknown';
      res.setHeader('X-Should-Retry', state === 'not_accepted' &&
        (!(error instanceof RequestError) || [429,503].includes(error.status)) ? 'true' : 'false');
      return json(res,error instanceof RequestError ? error.status : 503,{error:{
        code:error instanceof RequestError ? error.code : 'request_unavailable',
        message:error instanceof RequestError ? error.message : 'Check the existing request before continuing.',execution_state:state,
      }});
    } finally {
      if (queueAbort) {
        req.off('aborted', abortQueueWait);
        res.off('close', abortQueueWait);
        queueExecution?.signal.removeEventListener('abort',queueSignalAbort);
      }
      if (admission) this.observeAdmission(admission, 'terminal', undefined, this.terminalAdmissionReason(admission));
      admission?.cleanup();
      releaseStream?.(); releaseRequest?.(); if (ownsLock && lock) this.pending.delete(lock);
    }
  }
  private async stream(response:Response,res:http.ServerResponse) {
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    const reader=response.body!.getReader(), decoder=new TextDecoder();let buffer='';
    const closed=new AbortController();const close=()=>{closed.abort();void reader.cancel().catch(()=>{});};res.once('close',close);
    try { for (;;) { const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});if(buffer.length>2*1024*1024)throw Error('Frame too large.');
      let boundary;while((boundary=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const raw=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');
        if(raw==='[DONE]'){res.write('data: [DONE]\n\n');continue;}if(!raw)continue;
        const d=JSON.parse(raw);if(d.error){res.write(`data: ${JSON.stringify({error:{code:'request_failed',message:'The request could not complete.',execution_state:d.execution_state==='failed'?'failed':'unknown'}})}\n\n`);continue;}
        const safe={id:typeof d.id==='string'&&/^[-\w.:]{1,128}$/.test(d.id)?d.id:undefined,object:'chat.completion.chunk',choices:Array.isArray(d.choices)?d.choices.slice(0,16).map((c:any,index:number)=>({index,delta:{...(typeof c.delta?.content==='string'?{content:c.delta.content}:{}),...(c.delta?.role==='assistant'?{role:'assistant'}:{}),...(c.delta?.tool_calls!==undefined?{tool_calls:functionCalls(c.delta.tool_calls).map((call,index)=>({index,...call}))}:{})},finish_reason:['stop','length','content_filter','tool_calls'].includes(c.finish_reason)?c.finish_reason:null})):[],
          ...(publicUsage(d.usage)?{usage:publicUsage(d.usage)}:{})};
        const id=/^id: (\d{1,16})$/m.exec(frame)?.[1];if(!res.write(`${id?`id: ${id}\n`:''}data: ${JSON.stringify(safe)}\n\n`))await once(res,'drain',{signal:AbortSignal.any([closed.signal,AbortSignal.timeout(10000)])});
      }}res.end();
    } finally {res.off('close',close);await reader.cancel().catch(()=>{});}
  }
  stop():Promise<void>{
    if(this.stopPromise)return this.stopPromise;
    const operation=this.stopInternal();
    this.stopPromise=operation;
    return operation;
  }
  private async stopInternal(){
    this.draining=true;
    if(this.timer)clearTimeout(this.timer);
    this.timer=undefined;
    const failures:unknown[]=[];
    const queue=this.requestQueue;
    queue?.beginDrain();
    const serverClosed=new Promise<void>(resolve=>{if(!this.server.listening){resolve();return;}this.server.close(()=>resolve());});
    const initial=await Promise.allSettled([serverClosed,this.syncing??Promise.resolve()]);
    failures.push(...initial.flatMap(result=>result.status==='rejected'?[result.reason]:[]));
    const cleanup=await Promise.allSettled(queue?[queue.close()]:[]);
    failures.push(...cleanup.flatMap(result=>result.status==='rejected'?[result.reason]:[]));
    this.requestQueue=undefined;
    this.stopped=true;clearTimeout(this.timer);
    const finalSync=await Promise.allSettled(this.syncing?[this.syncing]:[]);
    failures.push(...finalSync.flatMap(result=>result.status==='rejected'?[result.reason]:[]));
    this.refreshedAt=0;this.scheduler.close();
    const engineCleanup=await Promise.allSettled([...this.workers.values()].map(worker=>worker.engine.stop()));
    failures.push(...engineCleanup.flatMap(result=>result.status==='rejected'?[result.reason]:[]));
    this.workers.clear();
    this.execution.stop();
    await this.execution.settlePending().catch(error=>failures.push(error));
    if(failures.length) throw new AggregateError(failures,'Premium runtime shutdown was incomplete');
  }
}

export const NovaPoolRuntime = PoolRuntime;
export type NovaPoolRuntime = PoolRuntime;
