-- ============================================================================
-- NOVA: Autonomous Inference Relay & Resource Routing Substrate
-- Distilled PostgreSQL Schema for Standalone Local Execution
-- No Supabase Auth, No Cloud Metadata, No External Vendor Bloat
-- ============================================================================

-- Ensure required extension and private schema
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE SCHEMA IF NOT EXISTS private;

-- ----------------------------------------------------------------------------
-- Safe Role Provisioning
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_relay_control') THEN
    CREATE ROLE nova_relay_control NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_relay_execution') THEN
    CREATE ROLE nova_relay_execution NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'galx_relay_control') THEN
    CREATE ROLE galx_relay_control NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'galx_relay_execution') THEN
    CREATE ROLE galx_relay_execution NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'galx_desktop_writer') THEN
    CREATE ROLE galx_desktop_writer NOLOGIN NOINHERIT;
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL; -- Gracefully proceed if running in constrained role environment
END $$;

-- ----------------------------------------------------------------------------
-- Enums (for strong typing & zero-downtime backward compatibility)
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'galx_credential_status') THEN
    CREATE TYPE public.galx_credential_status AS ENUM ('healthy', 'degraded', 'cooldown', 'exhausted', 'revoked', 'dead', 'quarantined', 'paused');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'nova_credential_status') THEN
    CREATE TYPE public.nova_credential_status AS ENUM ('healthy', 'degraded', 'cooldown', 'exhausted', 'revoked', 'dead', 'quarantined', 'paused');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'galx_provider_type') THEN
    CREATE TYPE public.galx_provider_type AS ENUM ('openai', 'anthropic', 'google', 'custom');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'galx_auth_type') THEN
    CREATE TYPE public.galx_auth_type AS ENUM ('api_key', 'oauth', 'session');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'galx_shard_mode') THEN
    CREATE TYPE public.galx_shard_mode AS ENUM ('pooled', 'dedicated', 'fallback', 'quarantined');
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 1. SHARD ACCOUNTS & LEASES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.nova_shard_accounts (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL DEFAULT 'system_admin',
  provider VARCHAR(64) NOT NULL DEFAULT 'openai',
  auth_type VARCHAR(64) NOT NULL DEFAULT 'oauth',
  account_label VARCHAR(128) NOT NULL DEFAULT 'Nova Shard Account',
  api_key_masked VARCHAR(64) NOT NULL DEFAULT 'oauth_********',
  -- AES-256-GCM Envelope
  encrypted_ciphertext TEXT NOT NULL,
  encrypted_iv VARCHAR(64) NOT NULL,
  encrypted_tag VARCHAR(64) NOT NULL,
  key_version VARCHAR(32) DEFAULT 'v1',
  shard_mode VARCHAR(32) NOT NULL DEFAULT 'pooled',
  priority INTEGER NOT NULL DEFAULT 10 CHECK (priority >= 1 AND priority <= 100),
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 1 AND weight <= 10),
  status VARCHAR(32) NOT NULL DEFAULT 'healthy',
  -- Token Bucket & Capacity
  max_tokens BIGINT NOT NULL DEFAULT 500000,
  remaining_tokens BIGINT NOT NULL DEFAULT 500000,
  reserved_tokens BIGINT NOT NULL DEFAULT 0,
  refill_rate_per_minute BIGINT NOT NULL DEFAULT 50000,
  max_requests INTEGER NOT NULL DEFAULT 40,
  remaining_requests INTEGER NOT NULL DEFAULT 40,
  last_refill_timestamp_ms BIGINT NOT NULL DEFAULT 0,
  token_refill_remainder NUMERIC(10, 9) NOT NULL DEFAULT 0,
  request_refill_remainder NUMERIC(10, 9) NOT NULL DEFAULT 0,
  token_refill_numerator BIGINT DEFAULT 0,
  request_refill_numerator BIGINT DEFAULT 0,
  max_concurrency_ceiling INTEGER NOT NULL DEFAULT 50,
  active_in_flight_count INTEGER NOT NULL DEFAULT 0,
  sliding_window_quota JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Usage & Circuit Metrics
  total_requests_served BIGINT NOT NULL DEFAULT 0,
  total_tokens_consumed BIGINT NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  average_latency_ms NUMERIC(10, 2) NOT NULL DEFAULT 250.00,
  last_latency_ms NUMERIC(10, 2) DEFAULT NULL,
  fencing_token BIGINT NOT NULL DEFAULT 1,
  permission_retracted BOOLEAN NOT NULL DEFAULT false,
  cooldown_until_ms BIGINT DEFAULT NULL,
  -- Enrollment & Expiry
  relay_pool_id TEXT DEFAULT NULL,
  managed_desktop_id UUID DEFAULT NULL,
  desktop_enrolled_at TIMESTAMPTZ DEFAULT NULL,
  credential_expires_at_ms BIGINT NOT NULL DEFAULT 0,
  credential_retired_at TIMESTAMPTZ DEFAULT NULL,
  registry_source TEXT NOT NULL DEFAULT 'manual',
  registry_revision BIGINT NOT NULL DEFAULT 1,
  created_at_ms BIGINT NOT NULL DEFAULT (extract(epoch FROM clock_timestamp())*1000)::bigint,
  updated_at_ms BIGINT NOT NULL DEFAULT (extract(epoch FROM clock_timestamp())*1000)::bigint,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS nova_shard_accounts_eligible_idx
  ON public.nova_shard_accounts(relay_pool_id, status, credential_expires_at_ms);

CREATE TABLE IF NOT EXISTS public.nova_shard_leases (
  id VARCHAR(64) PRIMARY KEY,
  shard_id VARCHAR(64) NOT NULL REFERENCES public.nova_shard_accounts(id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL DEFAULT 'system',
  job_id VARCHAR(128) DEFAULT NULL,
  fencing_token BIGINT NOT NULL DEFAULT 1,
  estimated_tokens BIGINT NOT NULL DEFAULT 2000,
  committed_tokens BIGINT DEFAULT NULL,
  acquired_at_ms BIGINT NOT NULL DEFAULT (extract(epoch FROM clock_timestamp())*1000)::bigint,
  expires_at_ms BIGINT NOT NULL,
  health_revision BIGINT DEFAULT 1,
  is_committed BOOLEAN NOT NULL DEFAULT false,
  is_reclaimed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS nova_shard_leases_active_idx
  ON public.nova_shard_leases(shard_id, expires_at_ms) WHERE NOT is_committed AND NOT is_reclaimed;

-- Backward compatibility views
CREATE OR REPLACE VIEW public.galx_shard_accounts AS SELECT * FROM public.nova_shard_accounts;
CREATE OR REPLACE VIEW public.galx_shard_leases AS SELECT * FROM public.nova_shard_leases;

-- Instead-of triggers so any writes to galx_shard_accounts redirect directly
CREATE OR REPLACE FUNCTION public.fn_galx_shard_accounts_instead_of()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.nova_shard_accounts VALUES (NEW.*);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE public.nova_shard_accounts
    SET user_id = NEW.user_id,
        provider = NEW.provider,
        auth_type = NEW.auth_type,
        account_label = NEW.account_label,
        api_key_masked = NEW.api_key_masked,
        encrypted_ciphertext = NEW.encrypted_ciphertext,
        encrypted_iv = NEW.encrypted_iv,
        encrypted_tag = NEW.encrypted_tag,
        key_version = NEW.key_version,
        shard_mode = NEW.shard_mode,
        priority = NEW.priority,
        weight = NEW.weight,
        status = NEW.status,
        max_tokens = NEW.max_tokens,
        remaining_tokens = NEW.remaining_tokens,
        reserved_tokens = NEW.reserved_tokens,
        refill_rate_per_minute = NEW.refill_rate_per_minute,
        max_requests = NEW.max_requests,
        remaining_requests = NEW.remaining_requests,
        last_refill_timestamp_ms = NEW.last_refill_timestamp_ms,
        total_requests_served = NEW.total_requests_served,
        total_tokens_consumed = NEW.total_tokens_consumed,
        consecutive_failures = NEW.consecutive_failures,
        consecutive_successes = NEW.consecutive_successes,
        average_latency_ms = NEW.average_latency_ms,
        last_latency_ms = NEW.last_latency_ms,
        fencing_token = NEW.fencing_token,
        permission_retracted = NEW.permission_retracted,
        cooldown_until_ms = NEW.cooldown_until_ms,
        active_in_flight_count = NEW.active_in_flight_count,
        relay_pool_id = NEW.relay_pool_id,
        managed_desktop_id = NEW.managed_desktop_id,
        desktop_enrolled_at = NEW.desktop_enrolled_at,
        credential_expires_at_ms = NEW.credential_expires_at_ms,
        credential_retired_at = NEW.credential_retired_at,
        registry_source = NEW.registry_source,
        registry_revision = NEW.registry_revision,
        max_concurrency_ceiling = NEW.max_concurrency_ceiling,
        token_refill_remainder = NEW.token_refill_remainder,
        request_refill_remainder = NEW.request_refill_remainder,
        token_refill_numerator = NEW.token_refill_numerator,
        request_refill_numerator = NEW.request_refill_numerator,
        sliding_window_quota = NEW.sliding_window_quota,
        updated_at_ms = NEW.updated_at_ms,
        updated_at = NEW.updated_at
    WHERE id = OLD.id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    DELETE FROM public.nova_shard_accounts WHERE id = OLD.id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_galx_shard_accounts_io ON public.galx_shard_accounts;
CREATE TRIGGER trg_galx_shard_accounts_io
INSTEAD OF INSERT OR UPDATE OR DELETE ON public.galx_shard_accounts
FOR EACH ROW EXECUTE FUNCTION public.fn_galx_shard_accounts_instead_of();

-- ----------------------------------------------------------------------------
-- 2. RELAY EXECUTION STORE (Isolated Neutral Outcomes)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS private.relay_identity (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
  pool_id TEXT NOT NULL DEFAULT 'premium' CHECK (pool_id = 'premium'),
  installation_id UUID NOT NULL,
  project_ref TEXT NOT NULL DEFAULT 'nova-local'
);

CREATE TABLE IF NOT EXISTS private.relay_executions (
  request_key TEXT PRIMARY KEY CHECK(request_key ~ '^[a-f0-9]{64}$'),
  request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  tenant_sha256 TEXT NOT NULL CHECK(tenant_sha256 ~ '^[a-f0-9]{64}$'),
  account_id TEXT NOT NULL,
  epoch UUID NOT NULL,
  execution_id TEXT NOT NULL UNIQUE CHECK(length(execution_id) BETWEEN 1 AND 96),
  workload TEXT NOT NULL CHECK(workload IN ('text','sites','images')),
  lease_id TEXT UNIQUE,
  state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','running','completed','unknown')),
  success BOOLEAN,
  actual_tokens BIGINT CHECK(actual_tokens BETWEEN 0 AND 1000000000),
  settled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS relay_executions_pending_idx
  ON private.relay_executions(created_at) WHERE NOT settled AND lease_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3. CENTRAL RELAY CONTROL & REGISTRATION
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS private.nova_relay_installations (
  id UUID PRIMARY KEY,
  pool_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'Nova Installation',
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, pool_id)
);

CREATE TABLE IF NOT EXISTS private.nova_relay_installation_runtime (
  installation_id UUID PRIMARY KEY REFERENCES private.nova_relay_installations(id) ON DELETE RESTRICT,
  registration_allowed BOOLEAN NOT NULL DEFAULT true,
  execution_allowed BOOLEAN NOT NULL DEFAULT true,
  automatic_activation BOOLEAN NOT NULL DEFAULT true,
  owner_epoch UUID,
  owner_generation BIGINT NOT NULL DEFAULT 0 CHECK(owner_generation >= 0),
  last_seen_at TIMESTAMPTZ,
  isolation_evidence_sha256 TEXT
);

CREATE TABLE IF NOT EXISTS private.nova_relay_principals (
  id UUID PRIMARY KEY,
  actor_id UUID NOT NULL,
  pool_id TEXT NOT NULL,
  installation_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('runtime','registrar','operator','viewer')),
  token_sha256 TEXT NOT NULL UNIQUE CHECK(token_sha256 ~ '^[a-f0-9]{64}$'),
  disabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(installation_id, pool_id) REFERENCES private.nova_relay_installations(id, pool_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS nova_relay_principals_scope_idx
  ON private.nova_relay_principals(installation_id, pool_id);

CREATE TABLE IF NOT EXISTS private.nova_relay_registrations (
  id UUID PRIMARY KEY,
  pool_id TEXT NOT NULL,
  installation_id UUID NOT NULL,
  desktop_id UUID NOT NULL UNIQUE,
  actor_id UUID NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 64),
  state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','reviewed','registered')),
  fingerprint TEXT CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
  account_class TEXT CHECK(account_class IN ('paid','free')),
  models JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(models)='array' AND jsonb_array_length(models)<=512),
  reviewed_at TIMESTAMPTZ,
  ticket_sha256 TEXT CHECK(ticket_sha256 ~ '^[a-f0-9]{64}$'),
  ticket_purpose TEXT CHECK(ticket_purpose IN ('review','register','refresh')),
  ticket_expires_at TIMESTAMPTZ,
  account_id VARCHAR(64) REFERENCES public.nova_shard_accounts(id) ON DELETE RESTRICT,
  management_revision BIGINT NOT NULL DEFAULT 1,
  removed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(installation_id, pool_id) REFERENCES private.nova_relay_installations(id, pool_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS private.nova_relay_account_assignments (
  account_id VARCHAR(64) PRIMARY KEY REFERENCES public.nova_shard_accounts(id) ON DELETE RESTRICT,
  pool_id TEXT NOT NULL,
  installation_id UUID NOT NULL,
  managed_desktop_id UUID,
  registration_operation_id UUID,
  assignment_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (account_id, pool_id, installation_id),
  FOREIGN KEY (installation_id, pool_id) REFERENCES private.nova_relay_installations(id, pool_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS private.nova_relay_account_control (
  account_id VARCHAR(64) PRIMARY KEY REFERENCES private.nova_relay_account_assignments(account_id) ON DELETE RESTRICT,
  account_class TEXT NOT NULL CHECK(account_class IN ('paid','free')),
  desired_state TEXT NOT NULL DEFAULT 'enabled' CHECK(desired_state IN ('enabled','paused','revoked')),
  desired_revision BIGINT NOT NULL DEFAULT 1 CHECK(desired_revision > 0),
  acknowledged_revision BIGINT,
  acknowledged_epoch UUID,
  acknowledged_at TIMESTAMPTZ,
  credential_revision TEXT NOT NULL CHECK(credential_revision ~ '^[a-f0-9]{64}$'),
  models JSONB NOT NULL CHECK(jsonb_typeof(models)='array' AND jsonb_array_length(models)<=512),
  connection_state TEXT NOT NULL DEFAULT 'connected' CHECK(connection_state IN ('connected', 'disconnected', 'sign_in_required', 'pending')),
  connection_checked_at TIMESTAMPTZ DEFAULT clock_timestamp(),
  rejected_credential_revision TEXT,
  removed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS private.nova_relay_control_operations (
  id UUID PRIMARY KEY,
  actor_id UUID NOT NULL,
  pool_id TEXT NOT NULL,
  installation_id UUID NOT NULL,
  account_id VARCHAR(64) NOT NULL REFERENCES private.nova_relay_account_assignments(account_id) ON DELETE RESTRICT,
  command TEXT NOT NULL CHECK(command IN ('enabled','paused','revoked','rename')),
  request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  saved_revision BIGINT NOT NULL CHECK(saved_revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(installation_id, pool_id) REFERENCES private.nova_relay_installations(id, pool_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS private.nova_relay_management_operations (
  id UUID PRIMARY KEY,
  actor_id UUID NOT NULL,
  pool_id TEXT NOT NULL,
  installation_id UUID NOT NULL,
  registration_id UUID NOT NULL,
  command TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS private.nova_relay_registration_operations (
  id UUID PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL,
  pool_id TEXT NOT NULL,
  installation_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  request_sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS private.nova_relay_lease_bindings (
  lease_id VARCHAR(64) PRIMARY KEY REFERENCES public.nova_shard_leases(id) ON DELETE RESTRICT,
  pool_id TEXT NOT NULL,
  installation_id UUID NOT NULL,
  account_id VARCHAR(64) NOT NULL,
  owner_epoch UUID NOT NULL,
  assignment_revision BIGINT NOT NULL,
  control_revision BIGINT NOT NULL,
  credential_revision TEXT NOT NULL CHECK(credential_revision ~ '^[a-f0-9]{64}$'),
  workload TEXT NOT NULL CHECK(workload IN ('text','sites','images')),
  request_key TEXT NOT NULL CHECK(request_key ~ '^[a-f0-9]{64}$'),
  request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  tenant_sha256 TEXT NOT NULL CHECK(tenant_sha256 ~ '^[a-f0-9]{64}$'),
  deadline_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(installation_id, request_key),
  FOREIGN KEY(installation_id, pool_id) REFERENCES private.nova_relay_installations(id, pool_id) ON DELETE RESTRICT,
  FOREIGN KEY(account_id, pool_id, installation_id) REFERENCES private.nova_relay_account_assignments(account_id, pool_id, installation_id) ON DELETE RESTRICT
);

-- Backward compatibility views for private tables
CREATE OR REPLACE VIEW private.galx_relay_installations AS SELECT * FROM private.nova_relay_installations;
CREATE OR REPLACE VIEW private.galx_relay_installation_runtime AS SELECT * FROM private.nova_relay_installation_runtime;
CREATE OR REPLACE VIEW private.galx_relay_principals AS SELECT * FROM private.nova_relay_principals;
CREATE OR REPLACE VIEW private.galx_relay_registrations AS SELECT * FROM private.nova_relay_registrations;
CREATE OR REPLACE VIEW private.galx_relay_account_assignments AS SELECT * FROM private.nova_relay_account_assignments;
CREATE OR REPLACE VIEW private.galx_relay_account_control AS SELECT * FROM private.nova_relay_account_control;
CREATE OR REPLACE VIEW private.galx_relay_control_operations AS SELECT * FROM private.nova_relay_control_operations;
CREATE OR REPLACE VIEW private.galx_relay_management_operations AS SELECT * FROM private.nova_relay_management_operations;
CREATE OR REPLACE VIEW private.galx_relay_registration_operations AS SELECT * FROM private.nova_relay_registration_operations;
CREATE OR REPLACE VIEW private.galx_relay_lease_bindings AS SELECT * FROM private.nova_relay_lease_bindings;


-- ============================================================================
-- 4. STORED PROCEDURES & PL/PGSQL LOGIC
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Relay Execution: Action dispatcher for isolated outcomes
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.relay_execution(
  p_pool text,
  p_installation uuid,
  p_action text,
  p_body jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  r private.relay_executions%ROWTYPE;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM private.relay_identity WHERE pool_id=p_pool AND installation_id=p_installation) THEN
    RAISE EXCEPTION 'Execution scope mismatch' USING ERRCODE='42501';
  END IF;
  IF p_body IS NULL OR jsonb_typeof(p_body)<>'object' OR octet_length(p_body::text)>8192 THEN
    RAISE EXCEPTION 'Invalid request' USING ERRCODE='22023';
  END IF;

  IF p_action='identity' THEN
    RETURN jsonb_build_object('pool', p_pool, 'installationId', p_installation);
  END IF;

  IF p_action='recover' THEN
    IF p_body->>'epoch' IS NULL THEN RAISE EXCEPTION 'Missing owner epoch' USING ERRCODE='22023'; END IF;
    UPDATE private.relay_executions
    SET state='unknown', success=NULL, updated_at=clock_timestamp()
    WHERE state IN ('reserved','running') AND epoch IS DISTINCT FROM (p_body->>'epoch')::uuid;
    RETURN jsonb_build_object('recovered', true);
  END IF;

  IF p_action='pending' THEN
    RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'requestKey', x.request_key,
      'epoch', x.epoch,
      'leaseId', x.lease_id,
      'success', x.success,
      'actualTokens', x.actual_tokens
    )) FROM (
      SELECT * FROM private.relay_executions
      WHERE state IN ('completed','unknown') AND NOT settled AND lease_id IS NOT NULL
      ORDER BY created_at LIMIT 100
    ) x), '[]'::jsonb);
  END IF;

  IF p_action='reserve' THEN
    IF p_pool <> 'premium' THEN
      RAISE EXCEPTION 'Pool mismatch: only premium pool is supported' USING ERRCODE='42501';
    END IF;
    INSERT INTO private.relay_executions(
      request_key, request_sha256, tenant_sha256, account_id, epoch, execution_id, workload
    ) VALUES (
      p_body->>'requestKey', p_body->>'requestSha256', p_body->>'tenantSha256',
      p_body->>'accountId', (p_body->>'epoch')::uuid, p_body->>'executionId', p_body->>'workload'
    ) ON CONFLICT(request_key) DO NOTHING;
  END IF;

  IF p_action='lookup' THEN
    SELECT * INTO r FROM private.relay_executions
    WHERE (request_key=p_body->>'requestKey' OR execution_id=p_body->>'executionId')
      AND tenant_sha256=p_body->>'tenantSha256';
    IF NOT FOUND THEN RETURN NULL; END IF;
  ELSE
    SELECT * INTO r FROM private.relay_executions WHERE request_key=p_body->>'requestKey' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Execution not found' USING ERRCODE='P0002'; END IF;
  END IF;

  IF p_action='reserve' AND ROW(r.request_sha256, r.tenant_sha256, r.workload) IS DISTINCT FROM
     ROW(p_body->>'requestSha256', p_body->>'tenantSha256', p_body->>'workload') THEN
    RAISE EXCEPTION 'Execution conflict' USING ERRCODE='23505';
  END IF;

  IF p_action IN ('bind','finish') AND r.execution_id IS DISTINCT FROM p_body->>'executionId' THEN
    RAISE EXCEPTION 'Execution conflict' USING ERRCODE='23505';
  END IF;

  IF p_action='bind' THEN
    IF r.state<>'reserved' OR p_body->>'leaseId' IS NULL THEN
      RAISE EXCEPTION 'Execution already dispatched' USING ERRCODE='23505';
    END IF;
    UPDATE private.relay_executions
    SET lease_id=p_body->>'leaseId', state='running', updated_at=clock_timestamp()
    WHERE request_key=r.request_key RETURNING * INTO r;
  ELSIF p_action='finish' THEN
    IF r.state IN ('reserved','running') THEN
      UPDATE private.relay_executions
      SET state=CASE WHEN (p_body->>'success')::boolean IS TRUE THEN 'completed' ELSE 'unknown' END,
          success=(p_body->>'success')::boolean,
          actual_tokens=(p_body->>'actualTokens')::bigint,
          updated_at=clock_timestamp()
      WHERE request_key=r.request_key RETURNING * INTO r;
    END IF;
  ELSIF p_action='settled' THEN
    IF r.lease_id IS DISTINCT FROM p_body->>'leaseId' OR r.state NOT IN ('completed','unknown') THEN
      RAISE EXCEPTION 'Invalid settlement' USING ERRCODE='23505';
    END IF;
    UPDATE private.relay_executions
    SET settled=true, updated_at=clock_timestamp()
    WHERE request_key=r.request_key RETURNING * INTO r;
  ELSIF p_action NOT IN ('lookup','reserve') THEN
    RAISE EXCEPTION 'Unsupported action' USING ERRCODE='42501';
  END IF;

  RETURN jsonb_build_object(
    'requestKey', r.request_key,
    'requestSha256', r.request_sha256,
    'tenantSha256', r.tenant_sha256,
    'accountId', r.account_id,
    'epoch', r.epoch,
    'executionId', r.execution_id,
    'workload', r.workload,
    'leaseId', r.lease_id,
    'state', r.state,
    'success', r.success,
    'actualTokens', r.actual_tokens,
    'settled', r.settled
  );
END $$;

-- ----------------------------------------------------------------------------
-- Shard Desktop Manual Enrollment & Refresh
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.enroll_desktop_shard(
  p_desktop_id uuid,
  p_row jsonb,
  p_expected jsonb DEFAULT NULL
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_old public.nova_shard_accounts%ROWTYPE;
  v_id text := p_row->>'id';
  v_now bigint := (extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
  IF p_desktop_id IS NULL OR v_id IS NULL
    OR (v_id !~ '^(codex|nova)_sh_[a-f0-9]{24}$' AND length(v_id) < 5)
    OR COALESCE(p_row->>'user_id','') = ''
    OR COALESCE(p_row->>'encrypted_ciphertext','') = ''
    OR COALESCE(p_row->>'encrypted_iv','') = ''
    OR COALESCE(p_row->>'encrypted_tag','') = ''
    OR COALESCE((p_row->>'credential_expires_at_ms')::bigint,0) <= v_now + 30000 THEN
    RAISE EXCEPTION 'Invalid desktop enrollment' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_id, 0));
  SELECT * INTO v_old FROM public.nova_shard_accounts WHERE id = v_id FOR UPDATE;

  IF FOUND THEN
    IF v_old.permission_retracted OR v_old.status::text IN ('revoked','dead','quarantined')
      OR v_old.provider <> 'openai' OR v_old.user_id <> (p_row->>'user_id')
      OR (v_old.managed_desktop_id IS NOT NULL AND v_old.managed_desktop_id <> p_desktop_id) THEN
      RAISE EXCEPTION 'Enrollment conflict' USING ERRCODE = '23505';
    END IF;
    IF v_old.managed_desktop_id = p_desktop_id AND v_old.encrypted_ciphertext = (p_row->>'encrypted_ciphertext') THEN
      RETURN v_id;
    END IF;
    IF p_expected IS NULL OR ROW(v_old.encrypted_iv, v_old.encrypted_tag, v_old.key_version, v_old.encrypted_ciphertext)
      IS DISTINCT FROM ROW(p_expected->>'encrypted_iv', p_expected->>'encrypted_tag', p_expected->>'key_version', p_expected->>'encrypted_ciphertext') THEN
      RAISE EXCEPTION 'Credential changed; verify again' USING ERRCODE = '40001';
    END IF;

    UPDATE public.nova_shard_accounts
    SET managed_desktop_id = p_desktop_id,
        desktop_enrolled_at = COALESCE(desktop_enrolled_at, clock_timestamp()),
        encrypted_ciphertext = p_row->>'encrypted_ciphertext',
        encrypted_iv = p_row->>'encrypted_iv',
        encrypted_tag = p_row->>'encrypted_tag',
        key_version = p_row->>'key_version',
        credential_expires_at_ms = (p_row->>'credential_expires_at_ms')::bigint,
        updated_at_ms = v_now,
        updated_at = clock_timestamp()
    WHERE id = v_id;
  ELSE
    IF p_expected IS NOT NULL THEN RAISE EXCEPTION 'Enrollment conflict' USING ERRCODE='40001'; END IF;
    INSERT INTO public.nova_shard_accounts (
      id, user_id, provider, auth_type, account_label, api_key_masked,
      encrypted_ciphertext, encrypted_iv, encrypted_tag, key_version,
      shard_mode, status, priority, weight, max_tokens, remaining_tokens,
      refill_rate_per_minute, max_requests, remaining_requests,
      last_refill_timestamp_ms, created_at_ms, updated_at_ms,
      credential_expires_at_ms, registry_source, managed_desktop_id, desktop_enrolled_at
    ) VALUES (
      v_id, p_row->>'user_id', 'openai', 'oauth', 'Desktop account', 'oauth_********',
      p_row->>'encrypted_ciphertext', p_row->>'encrypted_iv', p_row->>'encrypted_tag', p_row->>'key_version',
      'pooled', 'healthy', 10, 1, 500000, 500000, 50000, 40, 40,
      v_now, v_now, v_now, (p_row->>'credential_expires_at_ms')::bigint, 'operator_import',
      p_desktop_id, clock_timestamp()
    );
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION private.refresh_desktop_shard(
  p_desktop_id uuid,
  p_id text,
  p_expected jsonb,
  p_next jsonb
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id text;
  v_now bigint := (extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
  IF p_desktop_id IS NULL OR COALESCE((p_next->>'credential_expires_at_ms')::bigint,0) <= v_now + 30000
    OR COALESCE(p_next->>'encrypted_ciphertext','')='' OR COALESCE(p_next->>'encrypted_iv','')='' OR COALESCE(p_next->>'encrypted_tag','')='' THEN
    RAISE EXCEPTION 'Invalid desktop credential' USING ERRCODE='22023';
  END IF;

  UPDATE public.nova_shard_accounts
  SET encrypted_ciphertext=p_next->>'encrypted_ciphertext',
      encrypted_iv=p_next->>'encrypted_iv',
      encrypted_tag=p_next->>'encrypted_tag',
      key_version=p_next->>'key_version',
      credential_expires_at_ms=(p_next->>'credential_expires_at_ms')::bigint,
      updated_at_ms=v_now,
      updated_at=clock_timestamp()
  WHERE id=p_id AND managed_desktop_id=p_desktop_id AND provider='openai'
    AND user_id=p_expected->>'user_id' AND NOT permission_retracted
    AND status::text NOT IN ('revoked','dead','quarantined')
    AND ROW(encrypted_iv, encrypted_tag, key_version, encrypted_ciphertext) IS NOT DISTINCT FROM
        ROW(p_expected->>'encrypted_iv', p_expected->>'encrypted_tag', p_expected->>'key_version', p_expected->>'encrypted_ciphertext')
  RETURNING id INTO v_id;

  RETURN v_id IS NOT NULL;
END $$;

-- ----------------------------------------------------------------------------
-- Base Lease Management (Continuous Exact Integer Refill)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.relay_base_acquire(
  p_shard_id VARCHAR(64),
  p_user_id VARCHAR(255),
  p_estimated_tokens BIGINT DEFAULT 2000,
  p_lease_ttl_ms BIGINT DEFAULT 120000,
  p_job_id VARCHAR(128) DEFAULT NULL,
  p_now_ms BIGINT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_shard public.nova_shard_accounts%ROWTYPE;
  v_existing public.nova_shard_leases%ROWTYPE;
  v_expired RECORD;
  v_lease_id VARCHAR(64);
  v_now_ms BIGINT;
  v_expires_at_ms BIGINT;
  v_new_fencing_token BIGINT;
  v_elapsed_ms NUMERIC;
  v_token_units NUMERIC;
  v_request_units NUMERIC;
BEGIN
  v_now_ms := COALESCE(p_now_ms, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT);

  IF p_estimated_tokens <= 0 OR p_estimated_tokens > 10000000 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'INVALID_TOKEN_RESERVATION');
  END IF;
  IF p_lease_ttl_ms < 1000 OR p_lease_ttl_ms > 1800000 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'INVALID_LEASE_TTL');
  END IF;
  IF p_job_id IS NULL OR btrim(p_job_id) = '' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'IDEMPOTENCY_KEY_REQUIRED');
  END IF;

  SELECT * INTO v_shard FROM public.nova_shard_accounts WHERE id = p_shard_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'SHARD_NOT_FOUND');
  END IF;

  SELECT * INTO v_existing
  FROM public.nova_shard_leases
  WHERE shard_id = p_shard_id AND user_id = p_user_id AND job_id = p_job_id AND is_reclaimed = false
  ORDER BY acquired_at_ms DESC LIMIT 1 FOR UPDATE;

  IF FOUND THEN
    IF v_existing.is_committed THEN
      RETURN jsonb_build_object('success', false, 'reason', 'LEASE_ALREADY_COMMITTED', 'lease_id', v_existing.id, 'fencing_token', v_existing.fencing_token);
    ELSIF v_existing.expires_at_ms >= v_now_ms THEN
      RETURN jsonb_build_object(
        'success', true, 'idempotent_replay', true, 'lease_id', v_existing.id,
        'shard_id', v_existing.shard_id, 'fencing_token', v_existing.fencing_token,
        'expires_at_ms', v_existing.expires_at_ms, 'estimated_tokens', v_existing.estimated_tokens,
        'health_revision', v_existing.health_revision, 'remaining_tokens', v_shard.remaining_tokens,
        'reserved_tokens', v_shard.reserved_tokens, 'remaining_requests', v_shard.remaining_requests,
        'active_in_flight_count', v_shard.active_in_flight_count
      );
    END IF;
  END IF;

  -- Reclaim expired uncommitted leases
  FOR v_expired IN
    UPDATE public.nova_shard_leases
    SET is_reclaimed = true, updated_at = clock_timestamp()
    WHERE shard_id = p_shard_id AND expires_at_ms < v_now_ms AND is_committed = false AND is_reclaimed = false
    RETURNING estimated_tokens
  LOOP
    v_shard.reserved_tokens := GREATEST(0, v_shard.reserved_tokens - v_expired.estimated_tokens);
    v_shard.active_in_flight_count := GREATEST(0, v_shard.active_in_flight_count - 1);
  END LOOP;

  -- Integer precision continuous refill
  v_elapsed_ms := CASE WHEN COALESCE(v_shard.last_refill_timestamp_ms, 0) <= 0 THEN 0
                       ELSE GREATEST(0, v_now_ms::NUMERIC - v_shard.last_refill_timestamp_ms::NUMERIC) END;
  v_token_units := COALESCE(v_shard.token_refill_numerator::NUMERIC, v_shard.token_refill_remainder * 3000000000)
                   + v_elapsed_ms * v_shard.refill_rate_per_minute::NUMERIC * 50000;
  v_request_units := COALESCE(v_shard.request_refill_numerator::NUMERIC, v_shard.request_refill_remainder * 3000000000)
                     + v_elapsed_ms * v_shard.max_requests::NUMERIC * 50000;

  v_shard.remaining_tokens := LEAST(v_shard.max_tokens::NUMERIC, v_shard.remaining_tokens::NUMERIC + div(v_token_units, 3000000000))::BIGINT;
  v_shard.remaining_requests := LEAST(v_shard.max_requests::NUMERIC, v_shard.remaining_requests::NUMERIC + div(v_request_units, 3000000000))::INTEGER;
  v_shard.token_refill_numerator := CASE WHEN v_shard.remaining_tokens >= v_shard.max_tokens THEN 0 ELSE mod(v_token_units, 3000000000)::BIGINT END;
  v_shard.request_refill_numerator := CASE WHEN v_shard.remaining_requests >= v_shard.max_requests THEN 0 ELSE mod(v_request_units, 3000000000)::BIGINT END;

  UPDATE public.nova_shard_accounts
  SET remaining_tokens = v_shard.remaining_tokens,
      remaining_requests = v_shard.remaining_requests,
      reserved_tokens = v_shard.reserved_tokens,
      active_in_flight_count = v_shard.active_in_flight_count,
      token_refill_numerator = v_shard.token_refill_numerator,
      request_refill_numerator = v_shard.request_refill_numerator,
      token_refill_remainder = trunc(v_shard.token_refill_numerator::NUMERIC / 3000000000, 9),
      request_refill_remainder = trunc(v_shard.request_refill_numerator::NUMERIC / 3000000000, 9),
      last_refill_timestamp_ms = GREATEST(v_shard.last_refill_timestamp_ms, v_now_ms),
      updated_at_ms = v_now_ms,
      updated_at = clock_timestamp()
  WHERE id = p_shard_id;

  -- Health and quota admission gates
  IF v_shard.status NOT IN ('healthy', 'cooldown', 'exhausted') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'SHARD_NOT_HEALTHY', 'status', v_shard.status);
  END IF;
  IF v_shard.permission_retracted THEN
    RETURN jsonb_build_object('success', false, 'reason', 'PERMISSION_RETRACTED');
  END IF;
  IF v_shard.cooldown_until_ms IS NOT NULL AND v_shard.cooldown_until_ms > v_now_ms THEN
    RETURN jsonb_build_object('success', false, 'reason', 'SHARD_COOLDOWN', 'retry_at_ms', v_shard.cooldown_until_ms);
  END IF;
  IF v_shard.credential_expires_at_ms > 0 AND v_shard.credential_expires_at_ms <= v_now_ms THEN
    RETURN jsonb_build_object('success', false, 'reason', 'CREDENTIAL_EXPIRED');
  END IF;
  IF v_shard.active_in_flight_count >= v_shard.max_concurrency_ceiling THEN
    RETURN jsonb_build_object('success', false, 'reason', 'SHARD_CONCURRENCY_EXHAUSTED');
  END IF;
  IF (v_shard.remaining_requests - v_shard.active_in_flight_count) < 1 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'SHARD_REQUEST_QUOTA_EXHAUSTED');
  END IF;
  IF (v_shard.remaining_tokens - v_shard.reserved_tokens) < p_estimated_tokens THEN
    RETURN jsonb_build_object('success', false, 'reason', 'SHARD_TOKEN_QUOTA_EXHAUSTED');
  END IF;

  v_expires_at_ms := v_now_ms + p_lease_ttl_ms;
  v_new_fencing_token := v_shard.fencing_token + 1;
  v_lease_id := 'lease_' || replace(gen_random_uuid()::text, '-', '');

  UPDATE public.nova_shard_accounts
  SET reserved_tokens = reserved_tokens + p_estimated_tokens,
      active_in_flight_count = active_in_flight_count + 1,
      fencing_token = v_new_fencing_token,
      updated_at_ms = v_now_ms,
      updated_at = clock_timestamp()
  WHERE id = p_shard_id;

  INSERT INTO public.nova_shard_leases (
    id, shard_id, user_id, job_id, fencing_token, estimated_tokens,
    acquired_at_ms, expires_at_ms, health_revision
  ) VALUES (
    v_lease_id, p_shard_id, p_user_id, p_job_id, v_new_fencing_token,
    p_estimated_tokens, v_now_ms, v_expires_at_ms, v_shard.registry_revision
  );

  RETURN jsonb_build_object(
    'success', true,
    'idempotent_replay', false,
    'lease_id', v_lease_id,
    'shard_id', p_shard_id,
    'fencing_token', v_new_fencing_token,
    'expires_at_ms', v_expires_at_ms,
    'estimated_tokens', p_estimated_tokens,
    'health_revision', v_shard.registry_revision,
    'remaining_tokens', v_shard.remaining_tokens,
    'reserved_tokens', v_shard.reserved_tokens + p_estimated_tokens,
    'remaining_requests', v_shard.remaining_requests,
    'active_in_flight_count', v_shard.active_in_flight_count + 1
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.relay_base_release(
  p_lease_id VARCHAR(64),
  p_actual_tokens BIGINT DEFAULT NULL,
  p_latency_ms NUMERIC(10, 2) DEFAULT NULL,
  p_success BOOLEAN DEFAULT true,
  p_now_ms BIGINT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_shard_id VARCHAR(64);
  v_lease public.nova_shard_leases%ROWTYPE;
  v_shard public.nova_shard_accounts%ROWTYPE;
  v_tokens_to_deduct BIGINT;
  v_now_ms BIGINT;
  v_new_avg_latency NUMERIC(10, 2);
  v_recovered BOOLEAN;
  v_health_current BOOLEAN;
BEGIN
  v_now_ms := COALESCE(p_now_ms, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT);
  SELECT shard_id INTO v_shard_id FROM public.nova_shard_leases WHERE id = p_lease_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'reason', 'LEASE_NOT_FOUND'); END IF;

  SELECT * INTO v_shard FROM public.nova_shard_accounts WHERE id = v_shard_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'reason', 'SHARD_NOT_FOUND'); END IF;

  SELECT * INTO v_lease FROM public.nova_shard_leases WHERE id = p_lease_id FOR UPDATE;
  IF v_lease.is_committed THEN
    RETURN jsonb_build_object('success', true, 'idempotent_replay', true, 'lease_id', v_lease.id, 'committed_tokens', v_lease.committed_tokens, 'reason', 'LEASE_ALREADY_COMMITTED');
  END IF;
  IF v_lease.is_reclaimed THEN
    RETURN jsonb_build_object('success', false, 'reason', 'LEASE_RECLAIMED');
  END IF;

  v_tokens_to_deduct := COALESCE(p_actual_tokens, v_lease.estimated_tokens);
  v_new_avg_latency := CASE WHEN p_latency_ms IS NULL THEN v_shard.average_latency_ms
                            ELSE (0.2 * p_latency_ms) + (0.8 * v_shard.average_latency_ms) END;

  v_health_current := v_lease.expires_at_ms >= v_now_ms
    AND v_lease.fencing_token = v_shard.fencing_token
    AND NOT v_shard.permission_retracted
    AND v_shard.status NOT IN ('paused', 'revoked', 'dead');

  v_recovered := p_success IS TRUE AND v_health_current
    AND v_shard.status IN ('cooldown', 'exhausted')
    AND v_shard.cooldown_until_ms > 0
    AND v_shard.cooldown_until_ms <= v_lease.acquired_at_ms;

  UPDATE public.nova_shard_accounts
  SET status = CASE WHEN v_recovered THEN 'healthy' ELSE status END,
      cooldown_until_ms = CASE WHEN v_recovered THEN NULL ELSE cooldown_until_ms END,
      reserved_tokens = GREATEST(0, reserved_tokens - v_lease.estimated_tokens),
      remaining_tokens = GREATEST(0, remaining_tokens - v_tokens_to_deduct),
      remaining_requests = GREATEST(0, remaining_requests - 1),
      active_in_flight_count = GREATEST(0, active_in_flight_count - 1),
      total_tokens_consumed = total_tokens_consumed + v_tokens_to_deduct,
      total_requests_served = total_requests_served + 1,
      consecutive_failures = CASE WHEN p_success IS NULL OR NOT v_health_current THEN consecutive_failures
                                  WHEN p_success THEN 0 ELSE consecutive_failures + 1 END,
      consecutive_successes = CASE WHEN p_success IS NULL OR NOT v_health_current THEN consecutive_successes
                                   WHEN p_success THEN consecutive_successes + 1 ELSE 0 END,
      average_latency_ms = v_new_avg_latency,
      last_latency_ms = COALESCE(p_latency_ms, last_latency_ms),
      updated_at_ms = v_now_ms,
      updated_at = clock_timestamp()
  WHERE id = v_shard.id;

  UPDATE public.nova_shard_leases
  SET is_committed = true, committed_tokens = v_tokens_to_deduct, updated_at = clock_timestamp()
  WHERE id = v_lease.id;

  RETURN jsonb_build_object(
    'success', true,
    'idempotent_replay', false,
    'lease_id', p_lease_id,
    'committed_tokens', v_tokens_to_deduct,
    'remaining_tokens', GREATEST(0, v_shard.remaining_tokens - v_tokens_to_deduct)
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.relay_base_extend(
  p_lease_id VARCHAR(64),
  p_fencing_token BIGINT,
  p_extension_ms BIGINT DEFAULT 120000,
  p_now_ms BIGINT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_shard_id VARCHAR(64);
  v_lease public.nova_shard_leases%ROWTYPE;
  v_now_ms BIGINT;
  v_expires_at_ms BIGINT;
BEGIN
  v_now_ms := COALESCE(p_now_ms, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT);
  SELECT shard_id INTO v_shard_id FROM public.nova_shard_leases WHERE id = p_lease_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'reason', 'LEASE_NOT_FOUND'); END IF;

  PERFORM 1 FROM public.nova_shard_accounts WHERE id = v_shard_id FOR UPDATE;
  SELECT * INTO v_lease FROM public.nova_shard_leases WHERE id = p_lease_id FOR UPDATE;

  IF v_lease.is_committed OR v_lease.is_reclaimed THEN
    RETURN jsonb_build_object('success', false, 'reason', 'LEASE_INACTIVE');
  END IF;
  IF v_lease.fencing_token <> p_fencing_token THEN
    RETURN jsonb_build_object('success', false, 'reason', 'FENCING_TOKEN_MISMATCH');
  END IF;
  IF v_lease.expires_at_ms < v_now_ms THEN
    RETURN jsonb_build_object('success', false, 'reason', 'LEASE_EXPIRED');
  END IF;

  v_expires_at_ms := GREATEST(v_lease.expires_at_ms, v_now_ms + p_extension_ms);
  UPDATE public.nova_shard_leases SET expires_at_ms = v_expires_at_ms, updated_at = clock_timestamp() WHERE id = p_lease_id;

  RETURN jsonb_build_object('success', true, 'lease_id', p_lease_id, 'fencing_token', p_fencing_token, 'expires_at_ms', v_expires_at_ms);
END;
$$;

-- ----------------------------------------------------------------------------
-- Activation Reconciler
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.relay_reconcile_activation(p_installation uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  i private.nova_relay_installation_runtime%ROWTYPE;
BEGIN
  SELECT * INTO i FROM private.nova_relay_installation_runtime WHERE installation_id=p_installation FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Installation unavailable' USING ERRCODE='42501'; END IF;

  IF NOT i.execution_allowed AND i.automatic_activation AND i.registration_allowed
    AND i.owner_epoch IS NOT NULL
    AND i.last_seen_at <= clock_timestamp() AND i.last_seen_at > clock_timestamp() - interval '45 seconds'
    AND EXISTS (
      SELECT 1 FROM private.nova_relay_account_assignments a
      JOIN private.nova_relay_account_control c ON c.account_id=a.account_id
      JOIN public.nova_shard_accounts s ON s.id=a.account_id
      JOIN private.nova_relay_registrations r ON r.id=a.registration_operation_id
      WHERE a.installation_id=p_installation AND r.installation_id=a.installation_id AND r.pool_id=a.pool_id
        AND r.state='registered' AND r.removed_at IS NULL AND c.removed_at IS NULL
        AND c.desired_state='enabled' AND c.connection_state='connected'
        AND jsonb_array_length(c.models) > 0 AND NOT s.permission_retracted AND s.credential_retired_at IS NULL
        AND s.status::text NOT IN ('revoked','dead','quarantined','paused')
        AND (s.credential_expires_at_ms = 0 OR s.credential_expires_at_ms > (extract(epoch FROM clock_timestamp())*1000)::bigint + 30000)
    ) THEN
    UPDATE private.nova_relay_installation_runtime SET execution_allowed=true WHERE installation_id=p_installation;
    RETURN true;
  END IF;
  RETURN i.execution_allowed;
END $$;

-- ----------------------------------------------------------------------------
-- Central Relay Control Protocol
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.relay_control(
  p_token_sha256 text,
  p_action text,
  p_body jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  p private.nova_relay_principals%ROWTYPE;
  i private.nova_relay_installation_runtime%ROWTYPE;
  r private.nova_relay_registrations%ROWTYPE;
  a private.nova_relay_account_assignments%ROWTYPE;
  c private.nova_relay_account_control%ROWTYPE;
  s public.nova_shard_accounts%ROWTYPE;
  op private.nova_relay_control_operations%ROWTYPE;
  b private.nova_relay_lease_bindings%ROWTYPE;
  l public.nova_shard_leases%ROWTYPE;
  management private.nova_relay_management_operations%ROWTYPE;
  result jsonb;
  now_ms bigint;
  account text;
  command text;
  automatic boolean;
  activated boolean;
BEGIN
  IF p_body IS NULL OR jsonb_typeof(p_body)<>'object' OR octet_length(p_body::text)>262144 THEN
    RAISE EXCEPTION 'Invalid request' USING ERRCODE='22023';
  END IF;

  SELECT * INTO p FROM private.nova_relay_principals WHERE token_sha256=p_token_sha256 AND NOT disabled;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE='42501'; END IF;

  SELECT * INTO i FROM private.nova_relay_installation_runtime WHERE installation_id=p.installation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Installation unavailable' USING ERRCODE='42501'; END IF;

  IF p_body ? 'pool' AND p_body->>'pool' IS DISTINCT FROM p.pool_id THEN RAISE EXCEPTION 'Scope mismatch' USING ERRCODE='42501'; END IF;
  IF p_body ? 'installationId' AND (p_body->>'installationId')::uuid IS DISTINCT FROM p.installation_id THEN RAISE EXCEPTION 'Scope mismatch' USING ERRCODE='42501'; END IF;

  IF p_action='authenticate' THEN
    RETURN jsonb_build_object('id',p.id,'actorId',p.actor_id,'pool',p.pool_id,'installationId',p.installation_id,'kind',p.kind);
  END IF;

  IF p_action IN ('status','operation') AND p.kind IN ('operator','viewer') THEN
    IF p_action='operation' THEN
      SELECT * INTO r FROM private.nova_relay_registrations WHERE id=(p_body->>'id')::uuid AND installation_id=p.installation_id AND pool_id=p.pool_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
      RETURN jsonb_build_object('id',r.id,'desktopId',r.desktop_id,'name',r.name,'state',r.state,'accountId',r.account_id,'accountClass',r.account_class,'models',r.models,'updatedAt',r.updated_at,'revision',r.management_revision,'removedAt',r.removed_at);
    END IF;

    SELECT automatic_activation INTO automatic FROM private.nova_relay_installation_runtime WHERE installation_id=p.installation_id;

    RETURN jsonb_build_object(
      'pool', p.pool_id,
      'installationId', p.installation_id,
      'registrationAllowed', i.registration_allowed,
      'executionAllowed', i.execution_allowed,
      'automaticActivation', automatic,
      'lastSeenAt', i.last_seen_at,
      'epoch', i.owner_epoch,
      'accounts', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', aa.account_id, 'desktopId', aa.managed_desktop_id, 'name', ss.account_label,
        'state', cc.desired_state, 'revision', cc.desired_revision,
        'acknowledgedRevision', cc.acknowledged_revision, 'acknowledgedEpoch', cc.acknowledged_epoch,
        'acknowledgedAt', cc.acknowledged_at, 'models', cc.models, 'accountClass', cc.account_class,
        'credentialExpiresAt', ss.credential_expires_at_ms, 'removedAt', cc.removed_at,
        'updatedAt', cc.updated_at, 'cooldownUntilMs', ss.cooldown_until_ms,
        'consecutiveFailures', ss.consecutive_failures,
        'connectionState', cc.connection_state,
        'connectionCheckedAt', cc.connection_checked_at,
        'healthSignal', CASE WHEN ss.status::text IN ('dead','quarantined','revoked') THEN 'unavailable' WHEN ss.status::text IN ('cooldown','exhausted') THEN 'cooldown' ELSE 'none' END
      ) ORDER BY aa.created_at, aa.account_id)
      FROM private.nova_relay_account_assignments aa
      JOIN private.nova_relay_account_control cc ON cc.account_id = aa.account_id
      JOIN public.nova_shard_accounts ss ON ss.id = aa.account_id
      WHERE aa.installation_id = p.installation_id AND aa.pool_id = p.pool_id), '[]'::jsonb),
      'registrations', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', rr.id, 'desktopId', rr.desktop_id, 'name', rr.name, 'state', rr.state,
        'accountId', rr.account_id, 'accountClass', rr.account_class, 'models', rr.models,
        'updatedAt', rr.updated_at, 'revision', rr.management_revision, 'removedAt', rr.removed_at
      ) ORDER BY rr.created_at, rr.id)
      FROM private.nova_relay_registrations rr
      WHERE rr.installation_id = p.installation_id AND rr.pool_id = p.pool_id), '[]'::jsonb),
      'activity', COALESCE((SELECT jsonb_agg(x.item ORDER BY x.at DESC, x.id) FROM (
        SELECT item, (item->>'at')::timestamptz AS at, item->>'id' AS id FROM (
          SELECT jsonb_build_object('id', oo.id, 'accountId', oo.account_id, 'command', oo.command, 'revision', oo.saved_revision, 'at', oo.created_at) item
            FROM private.nova_relay_control_operations oo WHERE oo.installation_id = p.installation_id AND oo.pool_id = p.pool_id
          UNION ALL
          SELECT jsonb_build_object('id', mm.id, 'registrationId', mm.registration_id, 'name', mm.result->>'name', 'command', mm.command, 'at', mm.created_at)
            FROM private.nova_relay_management_operations mm WHERE mm.installation_id = p.installation_id AND mm.pool_id = p.pool_id
        ) events ORDER BY at DESC, id LIMIT 100) x), '[]'::jsonb)
    );
  END IF;

  IF p_action='manage_registration' AND p.kind='operator' THEN
    IF p_body->>'id' IS NULL OR p_body->>'registrationId' IS NULL OR p_body->>'expectedRevision' IS NULL
      OR p_body->>'requestSha256' IS NULL OR p_body->>'command' NOT IN ('rename','remove','restore') THEN
      RAISE EXCEPTION 'Invalid management action' USING ERRCODE='22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_body->>'id', 10));
    SELECT * INTO management FROM private.nova_relay_management_operations WHERE id=(p_body->>'id')::uuid;
    IF FOUND THEN
      IF management.actor_id<>p.actor_id OR management.pool_id<>p.pool_id OR management.installation_id<>p.installation_id
        OR management.registration_id<>(p_body->>'registrationId')::uuid OR management.request_sha256<>p_body->>'requestSha256' THEN
        RAISE EXCEPTION 'Operation conflict' USING ERRCODE='23505';
      END IF;
      RETURN management.result || jsonb_build_object('replayed',true);
    END IF;

    SELECT * INTO r FROM private.nova_relay_registrations WHERE id=(p_body->>'registrationId')::uuid AND pool_id=p.pool_id AND installation_id=p.installation_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
    IF r.management_revision IS DISTINCT FROM (p_body->>'expectedRevision')::bigint THEN RAISE EXCEPTION 'Registration changed' USING ERRCODE='40001'; END IF;
    IF r.account_id IS NOT NULL THEN RAISE EXCEPTION 'Manage the registered account' USING ERRCODE='42501'; END IF;

    command:=p_body->>'command';
    IF command='restore' THEN
      IF NOT i.registration_allowed OR r.removed_at IS NULL THEN RAISE EXCEPTION 'Restore unavailable' USING ERRCODE='42501'; END IF;
      UPDATE private.nova_relay_registrations SET removed_at=NULL, updated_at=clock_timestamp() WHERE id=r.id RETURNING * INTO r;
    ELSE
      IF r.removed_at IS NOT NULL THEN RAISE EXCEPTION 'Registration removed' USING ERRCODE='42501'; END IF;
      IF command='rename' THEN
        IF p_body->>'name' IS NULL OR length(btrim(p_body->>'name')) NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'Invalid name' USING ERRCODE='22023'; END IF;
        UPDATE private.nova_relay_registrations SET name=btrim(p_body->>'name'), updated_at=clock_timestamp() WHERE id=r.id RETURNING * INTO r;
      ELSE
        UPDATE private.nova_relay_registrations SET removed_at=clock_timestamp(), state='prepared', fingerprint=NULL, account_class=NULL, models='[]'::jsonb, reviewed_at=NULL, ticket_sha256=NULL, ticket_purpose=NULL, ticket_expires_at=NULL, updated_at=clock_timestamp() WHERE id=r.id RETURNING * INTO r;
      END IF;
    END IF;

    result:=jsonb_build_object('id',p_body->>'id','registrationId',r.id,'desktopId',r.desktop_id,'name',r.name,'savedRevision',r.management_revision,'removedAt',r.removed_at,'replayed',false);
    INSERT INTO private.nova_relay_management_operations(id,actor_id,pool_id,installation_id,registration_id,command,request_sha256,result)
      VALUES((p_body->>'id')::uuid,p.actor_id,p.pool_id,p.installation_id,r.id,command,p_body->>'requestSha256',result);
    RETURN result;
  END IF;

  IF p_action='prepare' AND p.kind='operator' THEN
    IF NOT i.registration_allowed THEN RAISE EXCEPTION 'Registration closed' USING ERRCODE='42501'; END IF;
    INSERT INTO private.nova_relay_registrations(id,pool_id,installation_id,desktop_id,actor_id,name)
      VALUES((p_body->>'id')::uuid,p.pool_id,p.installation_id,(p_body->>'desktopId')::uuid,p.actor_id,p_body->>'name') ON CONFLICT(id) DO NOTHING;
    SELECT * INTO r FROM private.nova_relay_registrations WHERE id=(p_body->>'id')::uuid FOR UPDATE;
    IF r.removed_at IS NOT NULL THEN RAISE EXCEPTION 'Registration removed' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('id',r.id,'desktopId',r.desktop_id,'name',r.name,'state',r.state,'accountId',r.account_id);
  END IF;

  IF p_action IN ('ticket','review','register','connect','refresh','registration_context') THEN
    IF (p_action='ticket' AND p.kind<>'operator') OR (p_action<>'ticket' AND p.kind<>'registrar') THEN
      RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';
    END IF;
    SELECT * INTO r FROM private.nova_relay_registrations WHERE id=(p_body->>'id')::uuid AND pool_id=p.pool_id AND installation_id=p.installation_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
    IF r.removed_at IS NOT NULL THEN RAISE EXCEPTION 'Registration removed' USING ERRCODE='42501'; END IF;

    IF p_action='ticket' THEN
      IF p_body->>'purpose' IS NULL OR p_body->>'ticketSha256' IS NULL OR p_body->>'purpose' NOT IN ('review','register','refresh','connect') THEN
        RAISE EXCEPTION 'Review required' USING ERRCODE='22023';
      END IF;
      UPDATE private.nova_relay_registrations
      SET ticket_sha256=p_body->>'ticketSha256', ticket_purpose=p_body->>'purpose', ticket_expires_at=clock_timestamp()+interval '2 minutes', updated_at=clock_timestamp()
      WHERE id=r.id;
      RETURN jsonb_build_object('id',r.id,'desktopId',r.desktop_id,'name',r.name,'state',r.state);
    END IF;

    IF p_body->>'ticketSha256' IS NULL OR r.ticket_sha256 IS DISTINCT FROM (p_body->>'ticketSha256') OR r.ticket_expires_at<=clock_timestamp() OR r.ticket_expires_at IS NULL THEN
      RAISE EXCEPTION 'Action authorization expired' USING ERRCODE='42501';
    END IF;

    IF p_action='registration_context' THEN
      RETURN jsonb_build_object('id',r.id,'desktopId',r.desktop_id,'pool',r.pool_id,'state',r.state,'fingerprint',r.fingerprint,'accountId',r.account_id,
        'accounts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',q.id,'user_id',q.user_id,'provider',q.provider,'auth_type',q.auth_type,'status',q.status,'permission_retracted',q.permission_retracted,'managed_desktop_id',q.managed_desktop_id,'encrypted_ciphertext',q.encrypted_ciphertext,'encrypted_iv',q.encrypted_iv,'encrypted_tag',q.encrypted_tag,'key_version',q.key_version))
        FROM public.nova_shard_accounts q WHERE q.provider='openai'),'[]'::jsonb));
    END IF;

    IF p_action='review' THEN
      UPDATE private.nova_relay_registrations SET state='reviewed', fingerprint=p_body->>'fingerprint', account_class=p_body->>'accountClass', models=p_body->'models', reviewed_at=clock_timestamp(), updated_at=clock_timestamp(), ticket_sha256=NULL WHERE id=r.id;
      RETURN jsonb_build_object('id',r.id,'desktopId',r.desktop_id,'name',r.name,'state','reviewed','accountClass',p_body->>'accountClass','models',p_body->'models');
    END IF;

    IF p_action IN ('register','connect') THEN
      IF r.state='registered' THEN
        RETURN jsonb_build_object('id',r.id,'accountId',r.account_id,'state','registered','replayed',true);
      END IF;
      account:=private.enroll_desktop_shard(r.desktop_id, p_body->'row', NULLIF(p_body->'expected','null'::jsonb));
      INSERT INTO private.nova_relay_account_assignments(account_id, pool_id, installation_id, managed_desktop_id, registration_operation_id)
        VALUES(account, p.pool_id, p.installation_id, r.desktop_id, r.id);
      INSERT INTO private.nova_relay_registration_operations(id, account_id, pool_id, installation_id, actor_id, request_sha256)
        VALUES(r.id, account, p.pool_id, p.installation_id, r.actor_id, COALESCE(p_body->>'fingerprint', hash(account)));
      UPDATE public.nova_shard_accounts SET relay_pool_id=p.pool_id, account_label=r.name WHERE id=account;
      INSERT INTO private.nova_relay_account_control(account_id, account_class, credential_revision, models, connection_state)
        VALUES(account, p_body->>'accountClass', p_body->>'credentialRevision', p_body->'models', 'connected')
        ON CONFLICT(account_id) DO UPDATE SET connection_state='connected', credential_revision=p_body->>'credentialRevision', models=p_body->'models', desired_state='enabled', desired_revision=private.nova_relay_account_control.desired_revision+1, updated_at=clock_timestamp();
      UPDATE private.nova_relay_registrations SET state='registered', account_id=account, updated_at=clock_timestamp() WHERE id=r.id;

      -- Automatic activation on registration
      SELECT automatic_activation INTO automatic FROM private.nova_relay_installation_runtime WHERE installation_id=p.installation_id;
      IF automatic THEN
        PERFORM private.relay_reconcile_activation(p.installation_id);
      END IF;

      RETURN jsonb_build_object('id',r.id,'accountId',account,'state','registered','replayed',false);
    END IF;

    IF p_action='refresh' THEN
      SELECT * INTO c FROM private.nova_relay_account_control WHERE account_id=r.account_id FOR UPDATE;
      IF c.credential_revision=p_body->>'credentialRevision' THEN
        RETURN jsonb_build_object('accountId',r.account_id,'state','current','revision',c.desired_revision);
      END IF;
      IF NOT private.refresh_desktop_shard(r.desktop_id, r.account_id, p_body->'expected', p_body->'row') THEN
        RAISE EXCEPTION 'Credential changed' USING ERRCODE='40001';
      END IF;
      UPDATE private.nova_relay_account_control
      SET credential_revision=p_body->>'credentialRevision', models=p_body->'models', connection_state='connected',
          desired_revision=desired_revision+1, updated_at=clock_timestamp()
      WHERE account_id=r.account_id RETURNING * INTO c;
      RETURN jsonb_build_object('accountId',r.account_id,'state','updated','revision',c.desired_revision);
    END IF;
  END IF;

  IF p_action='set_account' AND p.kind='operator' THEN
    SELECT * INTO a FROM private.nova_relay_account_assignments WHERE account_id=p_body->>'accountId' AND pool_id=p.pool_id AND installation_id=p.installation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_body->>'id', 9));
    SELECT * INTO op FROM private.nova_relay_control_operations WHERE id=(p_body->>'id')::uuid;
    IF FOUND THEN
      RETURN jsonb_build_object('id',op.id,'accountId',op.account_id,'desktopId',a.managed_desktop_id,'savedRevision',op.saved_revision,'replayed',true);
    END IF;

    SELECT * INTO c FROM private.nova_relay_account_control WHERE account_id=a.account_id FOR UPDATE;
    command:=p_body->>'command';
    IF command='rename' THEN
      UPDATE public.nova_shard_accounts SET account_label=btrim(p_body->>'name') WHERE id=a.account_id;
      UPDATE private.nova_relay_registrations SET name=btrim(p_body->>'name'), updated_at=clock_timestamp() WHERE account_id=a.account_id;
    END IF;

    UPDATE private.nova_relay_account_control
    SET desired_state=CASE WHEN command='rename' THEN desired_state WHEN command='remove' THEN 'revoked' ELSE command END,
        removed_at=CASE WHEN command='remove' THEN clock_timestamp() ELSE removed_at END,
        desired_revision=desired_revision+1, updated_at=clock_timestamp()
    WHERE account_id=a.account_id RETURNING * INTO c;

    IF command IN ('revoked','remove') THEN
      UPDATE public.nova_shard_accounts SET permission_retracted=true, status='revoked' WHERE id=a.account_id;
    END IF;

    INSERT INTO private.nova_relay_control_operations(id,actor_id,pool_id,installation_id,account_id,command,request_sha256,saved_revision)
      VALUES((p_body->>'id')::uuid,p.actor_id,p.pool_id,p.installation_id,a.account_id,command,p_body->>'requestSha256',c.desired_revision);

    -- Reconcile activation
    PERFORM private.relay_reconcile_activation(p.installation_id);

    RETURN jsonb_build_object('id',p_body->>'id','accountId',a.account_id,'desktopId',a.managed_desktop_id,'savedRevision',c.desired_revision,'replayed',false);
  END IF;

  -- Runtime commands
  IF p.kind<>'runtime' THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;

  IF p_action='claim' THEN
    SELECT * INTO i FROM private.nova_relay_installation_runtime WHERE installation_id=p.installation_id FOR UPDATE;
    IF p_body->>'epoch' IS NULL THEN RAISE EXCEPTION 'Missing epoch' USING ERRCODE='22023'; END IF;
    UPDATE private.nova_relay_installation_runtime
    SET owner_generation=owner_generation+CASE WHEN owner_epoch IS DISTINCT FROM (p_body->>'epoch')::uuid THEN 1 ELSE 0 END,
        owner_epoch=(p_body->>'epoch')::uuid, last_seen_at=clock_timestamp()
    WHERE installation_id=p.installation_id RETURNING * INTO i;
    activated:=private.relay_reconcile_activation(p.installation_id);
    RETURN jsonb_build_object('epoch',i.owner_epoch,'generation',i.owner_generation,'executionAllowed',activated);
  END IF;

  IF p_action='heartbeat' THEN
    UPDATE private.nova_relay_installation_runtime SET last_seen_at=clock_timestamp() WHERE installation_id=p.installation_id RETURNING * INTO i;
    activated:=private.relay_reconcile_activation(p.installation_id);
    RETURN jsonb_build_object('epoch',i.owner_epoch,'executionAllowed',activated);
  END IF;

  IF p_action='settle' THEN
    SELECT * INTO b FROM private.nova_relay_lease_bindings WHERE lease_id=p_body->>'leaseId' AND pool_id=p.pool_id AND installation_id=p.installation_id;
    IF NOT FOUND OR b.owner_epoch IS DISTINCT FROM (p_body->>'epoch')::uuid THEN
      RAISE EXCEPTION 'Lease not found' USING ERRCODE='P0002';
    END IF;
    result:=private.relay_base_release(b.lease_id, (p_body->>'actualTokens')::bigint, (p_body->>'latencyMs')::numeric, (p_body->>'success')::boolean, NULL);
    RETURN jsonb_build_object('success', result->'success', 'replayed', result->'idempotent_replay', 'reason', result->'reason');
  END IF;

  IF p_action='projection' THEN
    SELECT * INTO i FROM private.nova_relay_installation_runtime WHERE installation_id=p.installation_id;
    RETURN jsonb_build_object(
      'pool', p.pool_id, 'installationId', p.installation_id, 'epoch', i.owner_epoch, 'executionAllowed', i.execution_allowed,
      'accounts', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', aa.account_id, 'desktopId', aa.managed_desktop_id, 'assignmentRevision', aa.assignment_revision,
        'revision', cc.desired_revision, 'state', cc.desired_state, 'credentialRevision', cc.credential_revision,
        'models', cc.models, 'expiresAtMs', ss.credential_expires_at_ms, 'cooldownUntilMs', ss.cooldown_until_ms,
        'connectionState', cc.connection_state, 'connectionCheckedAt', cc.connection_checked_at,
        'envelope', CASE WHEN i.execution_allowed AND cc.desired_state='enabled' AND cc.connection_state='connected'
                              AND NOT ss.permission_retracted AND ss.status::text NOT IN ('revoked','dead','quarantined','paused')
                         THEN jsonb_build_object('id', ss.id, 'user_id', ss.user_id, 'provider', ss.provider, 'key_version', ss.key_version,
                                                 'encrypted_ciphertext', ss.encrypted_ciphertext, 'encrypted_iv', ss.encrypted_iv, 'encrypted_tag', ss.encrypted_tag)
                         ELSE NULL END
      ) ORDER BY aa.account_id)
      FROM private.nova_relay_account_assignments aa
      JOIN private.nova_relay_account_control cc ON cc.account_id=aa.account_id
      JOIN public.nova_shard_accounts ss ON ss.id=aa.account_id
      WHERE aa.pool_id=p.pool_id AND aa.installation_id=p.installation_id), '[]'::jsonb)
    );
  END IF;

  IF p_action='credential_failed' THEN
    SELECT * INTO a FROM private.nova_relay_account_assignments WHERE account_id=p_body->>'accountId' AND installation_id=p.installation_id AND pool_id=p.pool_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Account unavailable' USING ERRCODE='42501'; END IF;
    SELECT * INTO c FROM private.nova_relay_account_control WHERE account_id=a.account_id FOR UPDATE;
    IF c.credential_revision IS DISTINCT FROM p_body->>'credentialRevision' OR c.desired_revision IS DISTINCT FROM (p_body->>'revision')::bigint THEN
      RETURN jsonb_build_object('recorded', false);
    END IF;
    UPDATE private.nova_relay_account_control
    SET connection_state='sign_in_required', rejected_credential_revision=credential_revision,
        desired_revision=desired_revision+1, updated_at=clock_timestamp()
    WHERE account_id=a.account_id;
    RETURN jsonb_build_object('recorded', true);
  END IF;

  IF p_action='acknowledge' THEN
    SELECT * INTO a FROM private.nova_relay_account_assignments WHERE account_id=p_body->>'accountId' AND pool_id=p.pool_id AND installation_id=p.installation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
    SELECT * INTO c FROM private.nova_relay_account_control WHERE account_id=a.account_id FOR UPDATE;
    IF c.desired_revision IS DISTINCT FROM (p_body->>'revision')::bigint OR c.credential_revision IS DISTINCT FROM p_body->>'credentialRevision' THEN
      RAISE EXCEPTION 'Stale acknowledgement' USING ERRCODE='40001';
    END IF;
    UPDATE private.nova_relay_account_control
    SET acknowledged_revision=c.desired_revision, acknowledged_epoch=i.owner_epoch, acknowledged_at=clock_timestamp()
    WHERE account_id=a.account_id;
    RETURN jsonb_build_object('acknowledgedRevision', c.desired_revision);
  END IF;

  IF p_action='acquire' THEN
    SELECT * INTO a FROM private.nova_relay_account_assignments WHERE account_id=p_body->>'accountId' AND pool_id=p.pool_id AND installation_id=p.installation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
    SELECT * INTO c FROM private.nova_relay_account_control WHERE account_id=a.account_id FOR UPDATE;

    IF c.connection_state='sign_in_required' OR c.desired_state<>'enabled' THEN
      RAISE EXCEPTION 'Execution unavailable' USING ERRCODE='42501';
    END IF;

    SELECT * INTO b FROM private.nova_relay_lease_bindings WHERE installation_id=p.installation_id AND request_key=p_body->>'requestKey';
    IF FOUND THEN
      SELECT * INTO l FROM public.nova_shard_leases WHERE id=b.lease_id;
      IF l.is_committed OR l.is_reclaimed THEN RAISE EXCEPTION 'Execution already resolved' USING ERRCODE='23505'; END IF;
      RETURN jsonb_build_object('leaseId', l.id, 'fencingToken', l.fencing_token, 'expiresAtMs', l.expires_at_ms);
    END IF;

    result:=private.relay_base_acquire(a.account_id, (p_body->>'tenantSha256')::varchar, (p_body->>'estimatedTokens')::bigint, 30000, (p_body->>'requestKey')::varchar, NULL);
    IF NOT COALESCE((result->>'success')::boolean, false) THEN
      RETURN jsonb_build_object('denied', true, 'reason', result->>'reason');
    END IF;

    INSERT INTO private.nova_relay_lease_bindings(
      lease_id, pool_id, installation_id, account_id, owner_epoch, assignment_revision,
      control_revision, credential_revision, workload, request_key, request_sha256, tenant_sha256, deadline_at
    ) VALUES (
      result->>'lease_id', p.pool_id, p.installation_id, a.account_id, i.owner_epoch, a.assignment_revision,
      c.desired_revision, c.credential_revision, p_body->>'workload', p_body->>'requestKey',
      p_body->>'requestSha256', p_body->>'tenantSha256', clock_timestamp() + interval '10 minutes'
    );

    RETURN jsonb_build_object('leaseId', result->>'lease_id', 'fencingToken', result->'fencing_token', 'expiresAtMs', result->'expires_at_ms');
  END IF;

  IF p_action='renew' THEN
    SELECT * INTO b FROM private.nova_relay_lease_bindings WHERE lease_id=p_body->>'leaseId' AND pool_id=p.pool_id AND installation_id=p.installation_id;
    IF NOT FOUND OR b.owner_epoch<>i.owner_epoch THEN RAISE EXCEPTION 'Lease expired' USING ERRCODE='42501'; END IF;
    result:=private.relay_base_extend(b.lease_id, (p_body->>'fencingToken')::bigint, 30000, NULL);
    IF NOT COALESCE((result->>'success')::boolean, false) THEN RAISE EXCEPTION 'Lease expired' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('leaseId', b.lease_id, 'fencingToken', result->'fencing_token', 'expiresAtMs', result->'expires_at_ms');
  END IF;

  RAISE EXCEPTION 'Unsupported action: %', p_action USING ERRCODE='42501';
END $$;

-- ----------------------------------------------------------------------------
-- Public Forwarding Functions (compatible with legacy callers)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_acquire_shard_lease(
  p_shard_id VARCHAR(64),
  p_user_id VARCHAR(255),
  p_estimated_tokens BIGINT DEFAULT 2000,
  p_lease_ttl_ms BIGINT DEFAULT 120000,
  p_job_id VARCHAR(128) DEFAULT NULL,
  p_now_ms BIGINT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN private.relay_base_acquire(p_shard_id, p_user_id, p_estimated_tokens, p_lease_ttl_ms, p_job_id, p_now_ms);
END $$;

CREATE OR REPLACE FUNCTION public.fn_release_shard_lease(
  p_lease_id VARCHAR(64),
  p_actual_tokens BIGINT DEFAULT NULL,
  p_latency_ms NUMERIC(10, 2) DEFAULT NULL,
  p_success BOOLEAN DEFAULT true,
  p_now_ms BIGINT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN private.relay_base_release(p_lease_id, p_actual_tokens, p_latency_ms, p_success, p_now_ms);
END $$;

CREATE OR REPLACE FUNCTION public.fn_extend_shard_lease(
  p_lease_id VARCHAR(64),
  p_fencing_token BIGINT,
  p_extension_ms BIGINT DEFAULT 120000,
  p_now_ms BIGINT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN private.relay_base_extend(p_lease_id, p_fencing_token, p_extension_ms, p_now_ms);
END $$;
