-- Provision the SwimPilot application role.
--
-- Run this ONCE per database as a superuser (e.g. in the Supabase SQL editor,
-- or automatically by docker-compose during local Postgres init).
--
-- The application MUST connect as this role. RLS is the primary tenant-isolation
-- mechanism, and it can only protect us if the role is non-superuser AND not
-- BYPASSRLS. The init migration asserts this; if you change the role's
-- attributes later, the assertion will catch it on the next deploy.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swimpilot_app') THEN
    -- Password is intentionally a placeholder. On Supabase, replace with a real
    -- secret (ALTER ROLE swimpilot_app WITH PASSWORD '...') before connecting.
    -- Locally, docker-compose passes the password via env.
    CREATE ROLE swimpilot_app WITH LOGIN PASSWORD 'swimpilot_app_dev_password'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE swimpilot_app WITH LOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END$$;

GRANT USAGE ON SCHEMA public TO swimpilot_app;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public
  TO swimpilot_app;

GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA public
  TO swimpilot_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO swimpilot_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO swimpilot_app;
