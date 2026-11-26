-- =====================================================================
-- 005_tenant_fks — the database refuses cross-org references.
--
-- Foreign-key checks ignore RLS: a single-column FK such as leads.client_id -> clients(id) accepts ANY org's client id,
-- so before this migration only application code stopped org A's rows from pointing at org B's rows.
-- This migration makes every reference between two org-scoped tables carry the org:
--
--   parent:  UNIQUE (org_id, id)                                     (<table>_org_id_id_key)
--   child:   FOREIGN KEY (org_id, <col>) REFERENCES parent (org_id, id)   (same constraint name as before)
--
-- so a child row can only reference a parent row in its own org. ON DELETE behaviour is kept; SET NULL / SET DEFAULT
-- use the column-list form (PostgreSQL 15+), e.g. ON DELETE SET NULL (project_id), so org_id itself is never nulled.
-- MATCH SIMPLE (the default) keeps nullable references nullable: a NULL <col> is not checked.
-- References to global tables (organizations, which has no org_id) are left as they are. job_outbox only references
-- organizations, so its rows with NULL org_id (raw webhooks) are untouched.
--
-- Safety: before changing anything the migration counts, for every FK it would convert, the rows whose parent is in
-- another org. If there are any it stops with an error listing the count per FK and changes NOTHING (it is one
-- transaction). See README "Upgrading -> 005" for how to list and fix those rows, then re-run.
--
-- Run as the owner after 004 (a superuser in Docker). Idempotent: already-converted FKs are skipped.
--   docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U realcognix -d realcognix < db/migrations/005_tenant_fks.sql
-- A fresh volume runs it from infra/postgres/04-app-role.sh after 004 (a no-op there: db/schema.sql ends with the same
-- block). Keep this block and the copy at the end of db/schema.sql identical.
-- =====================================================================

DO $$
DECLARE
  fk record;
  privileged boolean := (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user);
  unforced text[] := '{}';
  t text;
  n bigint;
  total bigint := 0;
  report text := '';
  ondelete text;
  onupdate text;
  converted int := 0;
  uniques int := 0;
BEGIN
  -- Every single-column FK from an org-scoped table to the id of another (or the same) org-scoped table.
  IF to_regclass('pg_temp.rc_tenant_fks') IS NOT NULL THEN DROP TABLE pg_temp.rc_tenant_fks; END IF;
  CREATE TEMP TABLE rc_tenant_fks ON COMMIT DROP AS
  SELECT c.conname::text AS conname, c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
         a.attname::text AS col, c.confdeltype, c.confupdtype, c.condeferrable, c.condeferred,
         ca.attnotnull AS child_org_notnull
    FROM pg_constraint c
    JOIN pg_attribute a  ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1] AND pa.attname = 'id'
    JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attname = 'org_id' AND NOT ca.attisdropped
   WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
     AND cardinality(c.conkey) = 1 AND a.attname <> 'org_id'
     AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.confrelid AND x.attname = 'org_id' AND NOT x.attisdropped);

  IF NOT EXISTS (SELECT 1 FROM rc_tenant_fks) THEN
    RAISE NOTICE '005_tenant_fks: nothing to convert (already applied)';
    RETURN;
  END IF;

  FOR fk IN SELECT * FROM rc_tenant_fks WHERE NOT child_org_notnull LOOP
    RAISE EXCEPTION '005_tenant_fks: %.org_id is nullable; a composite FK would not protect rows with NULL org_id (constraint %)', fk.child, fk.conname;
  END LOOP;

  -- A non-superuser owner is subject to FORCEd RLS and would count only the rows of app.org_id. Lift FORCE for this
  -- transaction (owners bypass non-forced RLS) and put it back at the end; nobody else can see the table meanwhile.
  IF NOT privileged THEN
    FOR t IN SELECT DISTINCT x FROM (SELECT child FROM rc_tenant_fks UNION SELECT parent FROM rc_tenant_fks) s(x) LOOP
      IF (SELECT relforcerowsecurity FROM pg_class WHERE oid = t::regclass) THEN
        EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', t);
        unforced := unforced || t;
      END IF;
    END LOOP;
  END IF;

  -- 1. Refuse to run on data that already crosses orgs.
  FOR fk IN SELECT * FROM rc_tenant_fks ORDER BY child, col LOOP
    EXECUTE format('SELECT count(*) FROM %s c JOIN %s p ON p.id = c.%I WHERE p.org_id IS DISTINCT FROM c.org_id', fk.child, fk.parent, fk.col) INTO n;
    IF n > 0 THEN
      total := total + n;
      report := report || format(E'\n  %s.%s -> %s: %s row(s)   [constraint %s]', fk.child, fk.col, fk.parent, n, fk.conname);
    END IF;
  END LOOP;
  IF total > 0 THEN
    RAISE EXCEPTION '005_tenant_fks: % cross-org reference(s) found; nothing was changed', total
      USING DETAIL = 'Rows whose referenced parent belongs to a different org:' || report,
            HINT = 'List them with: SELECT c.id, c.org_id, c.<col>, p.org_id AS parent_org FROM <child> c JOIN <parent> p ON p.id = c.<col> '
                || 'WHERE p.org_id <> c.org_id;  Point each at a same-org row, set the column NULL, or delete the row; then re-run 005. '
                || 'See README "Upgrading -> 005".';
  END IF;

  -- 2. UNIQUE (org_id, id) on every referenced table (the target of the composite FKs).
  FOR t IN SELECT DISTINCT parent FROM rc_tenant_fks ORDER BY 1 LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint u
       WHERE u.conrelid = t::regclass AND u.contype IN ('u', 'p')
         AND u.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = t::regclass AND attname = 'org_id'),
                              (SELECT attnum FROM pg_attribute WHERE attrelid = t::regclass AND attname = 'id')]::int2[]) THEN
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I UNIQUE (org_id, id)', t, t || '_org_id_id_key');
      uniques := uniques + 1;
    END IF;
  END LOOP;

  -- 3. Replace each single-column FK with (org_id, col) -> parent (org_id, id), same name, same ON DELETE / ON UPDATE.
  FOR fk IN SELECT * FROM rc_tenant_fks ORDER BY child, col LOOP
    ondelete := CASE fk.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
                  WHEN 'n' THEN format('SET NULL (%I)', fk.col) WHEN 'd' THEN format('SET DEFAULT (%I)', fk.col) END;
    onupdate := CASE fk.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' END;
    IF onupdate IS NULL THEN
      RAISE EXCEPTION '005_tenant_fks: % has ON UPDATE SET NULL/DEFAULT, which cannot be kept on a composite key', fk.conname;
    END IF;
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I, ADD CONSTRAINT %I FOREIGN KEY (org_id, %I) REFERENCES %s (org_id, id) ON DELETE %s ON UPDATE %s%s',
      fk.child, fk.conname, fk.conname, fk.col, fk.parent, ondelete, onupdate,
      CASE WHEN fk.condeferrable THEN ' DEFERRABLE' || CASE WHEN fk.condeferred THEN ' INITIALLY DEFERRED' ELSE '' END ELSE '' END);
    converted := converted + 1;
  END LOOP;

  FOREACH t IN ARRAY unforced LOOP
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
  END LOOP;
  RAISE NOTICE '005_tenant_fks: % foreign keys now carry org_id; % UNIQUE (org_id, id) constraints added', converted, uniques;
END $$;
