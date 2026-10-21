-- ============================================================================
-- NOVA: Local PostgreSQL Development Seed Data
-- Pool: 'premium' (Single Authoritative Pool)
-- ============================================================================

-- 1. Default Premium Installation
INSERT INTO private.nova_relay_installations (id, pool_id, name)
VALUES
  ('00000000-0000-0000-0000-000000000001'::uuid, 'premium', 'Nova Premium Local Pool')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- 2. Installation Runtime Settings
INSERT INTO private.nova_relay_installation_runtime (
  installation_id, registration_allowed, execution_allowed, automatic_activation, owner_epoch, owner_generation, last_seen_at
)
VALUES
  ('00000000-0000-0000-0000-000000000001'::uuid, true, true, true, gen_random_uuid(), 1, clock_timestamp())
ON CONFLICT (installation_id) DO UPDATE
SET registration_allowed = true, execution_allowed = true, automatic_activation = true, last_seen_at = clock_timestamp();

-- 3. Execution Store Identity (Premium Pool)
INSERT INTO private.relay_identity (singleton, pool_id, installation_id, project_ref)
VALUES (true, 'premium', '00000000-0000-0000-0000-000000000001'::uuid, 'nova-local')
ON CONFLICT (singleton) DO UPDATE
SET pool_id = EXCLUDED.pool_id, installation_id = EXCLUDED.installation_id;

-- 4. Development Principals (Premium Pool)
-- Runtime:   nova-dev-runtime-token
-- Operator:  nova-dev-operator-token
-- Registrar: nova-dev-registrar-token
-- Viewer:    nova-dev-viewer-token
INSERT INTO private.nova_relay_principals (id, actor_id, pool_id, installation_id, kind, token_sha256, disabled)
VALUES
  ('11111111-1111-1111-1111-111111111111'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'premium', '00000000-0000-0000-0000-000000000001'::uuid, 'runtime', '706153a1745c0817161325076e484dcc969afc7c1eadc532c88f10689551ac69', false),
  ('22222222-2222-2222-2222-222222222222'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'premium', '00000000-0000-0000-0000-000000000001'::uuid, 'operator', '39ced00d01489b04f978ba7bf570193f4fda029d405d1144db3146f275f13acd', false),
  ('33333333-3333-3333-3333-333333333333'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'premium', '00000000-0000-0000-0000-000000000001'::uuid, 'registrar', 'dae0051f4134263c41e119f7a1723eabf408affb8d446a9cc8584f9e9752dcff', false),
  ('44444444-4444-4444-4444-444444444444'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'premium', '00000000-0000-0000-0000-000000000001'::uuid, 'viewer', 'd45b7ba0991bb30f091880b2b08e1dc268098ed694940036ad01433347254c14', false)
ON CONFLICT (id) DO UPDATE SET disabled = false;

-- 5. Seed Shard Account (Healthy Synthetic Shard for Premium Pool)
INSERT INTO public.nova_shard_accounts (
  id, user_id, provider, auth_type, account_label, api_key_masked,
  encrypted_ciphertext, encrypted_iv, encrypted_tag, key_version,
  shard_mode, priority, weight, status, max_tokens, remaining_tokens,
  refill_rate_per_minute, max_requests, remaining_requests,
  last_refill_timestamp_ms, created_at_ms, updated_at_ms,
  credential_expires_at_ms, registry_source, managed_desktop_id, desktop_enrolled_at,
  relay_pool_id
)
VALUES (
  'nova_sh_000000000000000000000001', 'system_admin', 'openai', 'oauth', 'Seed Local Shard', 'oauth_seed****',
  'synthetic_ciphertext', 'synthetic_iv', 'synthetic_tag', 'v1',
  'pooled', 10, 1, 'healthy', 500000, 500000,
  50000, 40, 40,
  (extract(epoch FROM clock_timestamp())*1000)::bigint,
  (extract(epoch FROM clock_timestamp())*1000)::bigint,
  (extract(epoch FROM clock_timestamp())*1000)::bigint,
  (extract(epoch FROM clock_timestamp())*1000 + 31536000000)::bigint, -- 1 year validity
  'seed', '00000000-0000-0000-0000-000000000001'::uuid, clock_timestamp(),
  'premium'
)
ON CONFLICT (id) DO UPDATE
SET status = 'healthy',
    credential_expires_at_ms = (extract(epoch FROM clock_timestamp())*1000 + 31536000000)::bigint,
    updated_at = clock_timestamp();
