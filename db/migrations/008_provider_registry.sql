-- =====================================================================
-- 008_provider_registry — per-org choice of vendors, switchable from the admin panel without a code change.
--
--   provider_configs  one row per configured provider ("connection") for a capability:
--                       llm (chat), embeddings, messaging, email, storage, ads, lead_sources, automations
--                     config      = non-secret settings (base URL, model, phone number id, SMTP host ...)
--                     secrets_enc = AES-256-GCM ciphertext of a JSON object of secrets (API keys, tokens, passwords),
--                                   encrypted by the API with CONFIG_MASTER_KEY and bound to (org, row id) as AAD.
--                                   Never returned to the browser; secret_hints holds masked previews ("gsk_…a1F3").
--                     is_primary  = the selected provider for single-choice capabilities (one per org + capability).
--   ai_agent_routes   per agent (default, lead_qualifier, follow_up, reporting, creative, scoring) an ordered chain of
--                     { connectionId, model } tried in order: the first that answers wins (fallback order).
-- Changes are recorded in audit_log (007). Org-scoped with RLS like every tenant table; no DELETE (archive instead).
--
-- Run as the owner after 007. Idempotent. db/schema.sql already contains the same objects for fresh installs.
-- =====================================================================

CREATE OR REPLACE FUNCTION pg_temp.rc_org_key(t regclass) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint u
     WHERE u.conrelid = t AND u.contype IN ('u', 'p')
       AND u.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = t AND attname = 'org_id'),
                            (SELECT attnum FROM pg_attribute WHERE attrelid = t AND attname = 'id')]::int2[]) THEN
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I UNIQUE (org_id, id)', t, t::text || '_org_id_id_key');
  END IF;
END $f$;
SELECT pg_temp.rc_org_key('users');

CREATE TABLE IF NOT EXISTS provider_configs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  capability       text NOT NULL CHECK (capability IN ('llm', 'embeddings', 'messaging', 'email', 'storage', 'ads', 'lead_sources', 'automations')),
  provider         text NOT NULL,                       -- groq, gemini, openrouter, ollama, whatsapp_cloud, smtp, s3, n8n ...
  label            text NOT NULL,
  enabled          boolean NOT NULL DEFAULT true,
  is_primary       boolean NOT NULL DEFAULT false,
  config           jsonb NOT NULL DEFAULT '{}'::jsonb,
  secrets_enc      text,
  secret_hints     jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_test_at     timestamptz,
  last_test_ok     boolean,
  last_test_error  text,
  archived_at      timestamptz,
  created_by       uuid,
  updated_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_configs_created_by_fkey FOREIGN KEY (org_id, created_by) REFERENCES users (org_id, id) ON DELETE SET NULL (created_by),
  CONSTRAINT provider_configs_updated_by_fkey FOREIGN KEY (org_id, updated_by) REFERENCES users (org_id, id) ON DELETE SET NULL (updated_by)
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_configs_primary_idx ON provider_configs (org_id, capability) WHERE is_primary AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS provider_configs_org_idx ON provider_configs (org_id, capability) WHERE archived_at IS NULL;
SELECT pg_temp.rc_org_key('provider_configs');

CREATE TABLE IF NOT EXISTS ai_agent_routes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent       text NOT NULL CHECK (agent IN ('default', 'lead_qualifier', 'follow_up', 'reporting', 'creative', 'scoring')),
  chain       jsonb NOT NULL DEFAULT '[]'::jsonb,        -- [{"connectionId": uuid, "model": "llama-3.3-70b-versatile"}, ...]
  temperature numeric(3,2),
  updated_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_routes_agent UNIQUE (org_id, agent),
  CONSTRAINT ai_agent_routes_updated_by_fkey FOREIGN KEY (org_id, updated_by) REFERENCES users (org_id, id) ON DELETE SET NULL (updated_by)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['provider_configs', 'ai_agent_routes'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_updated_at') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t || '_updated_at', t);
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = t || '_tenant') THEN
      EXECUTE format(
        'CREATE POLICY %I_tenant ON %I USING (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) '
        'WITH CHECK (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)', t, t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'realcognix_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO realcognix_app', t);
    END IF;
  END LOOP;
END $$;
