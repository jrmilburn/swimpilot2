-- Tenant isolation via Row-Level Security.
--
-- Tenant context is set per-request as a transaction-local GUC:
--   SELECT set_config('app.school_id', '<uuid>', true);
-- and policies match it against `school_id`. We use `current_setting(..., true)`
-- (the second arg returns NULL instead of erroring when the variable was never
-- registered in this session). However, once SET LOCAL has touched the
-- variable in any prior transaction on the same pooled connection, Postgres
-- keeps the variable registered and `current_setting` returns '' instead of
-- NULL after the transaction ends. We wrap with NULLIF(..., '') so both the
-- never-set and reset-to-empty cases produce NULL, and `<uuid> = NULL` is
-- NULL — meaning unscoped queries see zero rows rather than throwing.
--
-- `users` is intentionally NOT under RLS: it is a global table (one human can
-- be a member of multiple schools) and isolation happens via `memberships`.

-- Helper expression repeated below: NULLIF(current_setting('app.school_id', true), '')::uuid

-- 1. Schools — a row is visible iff its id matches the current tenant.
ALTER TABLE "schools" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "schools" FORCE ROW LEVEL SECURITY;

CREATE POLICY "schools_tenant_isolation" ON "schools"
  FOR ALL
  USING ("id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK ("id" = NULLIF(current_setting('app.school_id', true), '')::uuid);

-- 2. Memberships — scoped by school_id.
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;

CREATE POLICY "memberships_tenant_isolation" ON "memberships"
  FOR ALL
  USING ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid);

-- 3. Locations — scoped by school_id.
ALTER TABLE "locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;

CREATE POLICY "locations_tenant_isolation" ON "locations"
  FOR ALL
  USING ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid);

-- 4. Application-role contract.
-- The app role MUST exist, be able to log in, and lack both superuser and
-- BYPASSRLS. If any of those is wrong, RLS gives no real protection and we
-- fail the migration loudly rather than ship a false sense of security.
DO $$
DECLARE
  r record;
BEGIN
  SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
    INTO r
    FROM pg_roles
    WHERE rolname = 'swimpilot_app';

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Role "swimpilot_app" does not exist. Run scripts/db/01-create-app-role.sql first.';
  END IF;

  IF r.rolsuper THEN
    RAISE EXCEPTION 'Role "swimpilot_app" must NOT be SUPERUSER.';
  END IF;

  IF r.rolbypassrls THEN
    RAISE EXCEPTION 'Role "swimpilot_app" must NOT have BYPASSRLS.';
  END IF;

  IF NOT r.rolcanlogin THEN
    RAISE EXCEPTION 'Role "swimpilot_app" must have LOGIN.';
  END IF;
END$$;
