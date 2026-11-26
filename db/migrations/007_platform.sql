-- =====================================================================
-- 007_platform — team invites, channel-partner lead registration, daily ad metrics, microsite intake,
-- org settings writes, and an audit log.
--
--   user_invites                 one-time invite links (token stored as SHA-256 only), accepted via /auth/accept-invite
--   partner_lead_registrations   which partner registered which lead, for how long (90-day ownership), and refusals
--   campaign_daily_metrics       spend / impressions / clicks per campaign per day (ads sync or n8n posts them)
--   microsites                   + lead_source_id (form intake key), consent text + notice version, archived_at
--   organizations                the app may now UPDATE name, gstin, timezone and settings of its own org only
--   audit_log                    who changed what (settings, integrations, roles, payouts ...)
--
-- SECURITY DEFINER lookups (owned by realcognix_system, like 003): auth_invite_lookup (accept an invite before the org
-- is known), microsite_public_lookup (render a published microsite / post its form), org_by_slug (per-org webhooks).
--
-- Run as the owner after 006. Idempotent. db/schema.sql already contains the same objects for fresh installs.
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
SELECT pg_temp.rc_org_key(t) FROM unnest(ARRAY['users', 'roles', 'channel_partners', 'leads', 'projects', 'campaigns', 'lead_sources']::regclass[]) t;

-- ---------------------------------------------------------------- invites
CREATE TABLE IF NOT EXISTS user_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  email        citext NOT NULL,
  role_id      uuid NOT NULL,
  token_hash   text NOT NULL UNIQUE,                     -- sha256 of the invite token; the token itself is never stored
  invited_by   uuid,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_invites_user_id_fkey FOREIGN KEY (org_id, user_id) REFERENCES users (org_id, id) ON DELETE CASCADE,
  CONSTRAINT user_invites_role_id_fkey FOREIGN KEY (org_id, role_id) REFERENCES roles (org_id, id),
  CONSTRAINT user_invites_invited_by_fkey FOREIGN KEY (org_id, invited_by) REFERENCES users (org_id, id) ON DELETE SET NULL (invited_by)
);
CREATE INDEX IF NOT EXISTS user_invites_user_idx ON user_invites (user_id) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------- channel partner registrations
CREATE TABLE IF NOT EXISTS partner_lead_registrations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id     uuid NOT NULL,
  lead_id        uuid,
  project_id     uuid,
  phone_e164     text,
  status         text NOT NULL CHECK (status IN ('accepted', 'rejected')),
  reason         text,                                   -- buyer_exists, owned_by_other_partner, ...
  registered_at  timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,                            -- accepted: registered_at + ownership window
  registered_by  uuid,
  CONSTRAINT partner_lead_registrations_partner_id_fkey FOREIGN KEY (org_id, partner_id) REFERENCES channel_partners (org_id, id) ON DELETE CASCADE,
  CONSTRAINT partner_lead_registrations_lead_id_fkey FOREIGN KEY (org_id, lead_id) REFERENCES leads (org_id, id) ON DELETE CASCADE,
  CONSTRAINT partner_lead_registrations_project_id_fkey FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id) ON DELETE SET NULL (project_id),
  CONSTRAINT partner_lead_registrations_registered_by_fkey FOREIGN KEY (org_id, registered_by) REFERENCES users (org_id, id) ON DELETE SET NULL (registered_by)
);
CREATE INDEX IF NOT EXISTS partner_lead_registrations_partner_idx ON partner_lead_registrations (partner_id, registered_at DESC);
CREATE INDEX IF NOT EXISTS partner_lead_registrations_lead_idx ON partner_lead_registrations (lead_id) WHERE status = 'accepted';

-- ---------------------------------------------------------------- daily ad metrics
CREATE TABLE IF NOT EXISTS campaign_daily_metrics (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id   uuid NOT NULL,
  day           date NOT NULL,
  spend_inr     numeric(14,2) NOT NULL DEFAULT 0,
  impressions   bigint NOT NULL DEFAULT 0,
  clicks        bigint NOT NULL DEFAULT 0,
  leads_reported integer,                                -- platform-reported leads (ours come from the leads table)
  synced_at     timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_daily_metrics_campaign_id_fkey FOREIGN KEY (org_id, campaign_id) REFERENCES campaigns (org_id, id) ON DELETE CASCADE,
  CONSTRAINT campaign_daily_metrics_day UNIQUE (campaign_id, day)
);
CREATE INDEX IF NOT EXISTS campaign_daily_metrics_org_day_idx ON campaign_daily_metrics (org_id, day);

-- ---------------------------------------------------------------- microsites
ALTER TABLE microsites
  ADD COLUMN IF NOT EXISTS lead_source_id uuid,
  ADD COLUMN IF NOT EXISTS consent_text   text,
  ADD COLUMN IF NOT EXISTS notice_version text NOT NULL DEFAULT 'v1',
  ADD COLUMN IF NOT EXISTS archived_at    timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'microsites_lead_source_id_fkey') THEN
    ALTER TABLE microsites ADD CONSTRAINT microsites_lead_source_id_fkey FOREIGN KEY (org_id, lead_source_id) REFERENCES lead_sources (org_id, id) ON DELETE SET NULL (lead_source_id);
  END IF;
END $$;

-- ---------------------------------------------------------------- audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_type     text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'service', 'system')),
  actor_user_id  uuid,
  entity_type    text NOT NULL,                          -- provider_config, ai_route, org_settings, user, role, partner_payout ...
  entity_id      text,
  action         text NOT NULL,                          -- create, update, enable, disable, archive, test, select ...
  changes        jsonb NOT NULL DEFAULT '{}'::jsonb,     -- secrets are never written here, only "changed"
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_actor_user_id_fkey FOREIGN KEY (org_id, actor_user_id) REFERENCES users (org_id, id) ON DELETE SET NULL (actor_user_id)
);
CREATE INDEX IF NOT EXISTS audit_log_org_idx ON audit_log (org_id, created_at DESC);

-- ---------------------------------------------------------------- RLS, triggers, grants for the new tables
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_invites', 'partner_lead_registrations', 'campaign_daily_metrics', 'audit_log'] LOOP
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
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'campaign_daily_metrics_updated_at') THEN
    CREATE TRIGGER campaign_daily_metrics_updated_at BEFORE UPDATE ON campaign_daily_metrics FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'realcognix_app') THEN
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO realcognix_app;     -- audit_log identity
    GRANT UPDATE (name, gstin, timezone, settings) ON organizations TO realcognix_app;
  END IF;
  -- Each org may update only its own row (SELECT policy organizations_self already exists).
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'organizations' AND policyname = 'organizations_self_update') THEN
    CREATE POLICY organizations_self_update ON organizations FOR UPDATE
      USING (id = NULLIF(current_setting('app.org_id', true), '')::uuid)
      WITH CHECK (id = NULLIF(current_setting('app.org_id', true), '')::uuid);
  END IF;
END $$;

-- ---------------------------------------------------------------- SECURITY DEFINER lookups
-- Accept an invite: runs before the org is known. Returns the minimum to finish the sign-up scoped to that org.
CREATE OR REPLACE FUNCTION auth_invite_lookup(p_token_hash text)
RETURNS TABLE (invite_id uuid, org_id uuid, user_id uuid, email text, full_name text, org_name text,
               expires_at timestamptz, accepted_at timestamptz, revoked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.org_id, i.user_id, i.email::text, u.full_name, o.name, i.expires_at, i.accepted_at, i.revoked_at
    FROM user_invites i JOIN users u ON u.id = i.user_id JOIN organizations o ON o.id = i.org_id
   WHERE i.token_hash = p_token_hash
$$;

-- Public microsite: a published, non-archived microsite by slug or custom domain. Ids only.
CREATE OR REPLACE FUNCTION microsite_public_lookup(p_slug text, p_domain text DEFAULT NULL)
RETURNS TABLE (org_id uuid, microsite_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.org_id, m.id FROM microsites m
   WHERE m.status = 'published' AND m.archived_at IS NULL
     AND ((p_slug IS NOT NULL AND m.slug = p_slug) OR (p_domain IS NOT NULL AND m.custom_domain = lower(p_domain)))
   ORDER BY m.published_at DESC NULLS LAST LIMIT 1
$$;

-- Per-org webhook URLs carry the org slug: resolve it to the id (the secret is then checked scoped to that org).
CREATE OR REPLACE FUNCTION org_by_slug(p_slug text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.id FROM organizations o WHERE o.slug = p_slug
$$;

DO $$
DECLARE f text;
  fns text[] := ARRAY['auth_invite_lookup(text)', 'microsite_public_lookup(text,text)', 'org_by_slug(text)'];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'realcognix_system') THEN
    GRANT USAGE ON SCHEMA public TO realcognix_system;
    GRANT SELECT ON user_invites, users, organizations, microsites TO realcognix_system;
    GRANT CREATE ON SCHEMA public TO realcognix_system;
    FOREACH f IN ARRAY fns LOOP
      EXECUTE format('ALTER FUNCTION %s OWNER TO realcognix_system', f);
    END LOOP;
    REVOKE CREATE ON SCHEMA public FROM realcognix_system;
  END IF;
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'realcognix_app') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO realcognix_app', f);
    END IF;
  END LOOP;
END $$;
