-- Add `slug` to schools.
--
-- Slugs are the public URL identifier for a tenant (`/s/<slug>`). They must
-- be unique. We add the column as nullable, backfill the seeded rows, then
-- enforce NOT NULL — safe both for an empty dev DB and for a populated one
-- that may have other rows around.

ALTER TABLE "schools" ADD COLUMN "slug" TEXT;

-- Backfill any existing rows: prefer the canonical seed slugs for the two
-- known seed schools (matched by name), otherwise fall back to a slugified
-- name + short id suffix to satisfy uniqueness.
UPDATE "schools"
SET "slug" = CASE
  WHEN lower("name") = 'riverside swim school' THEN 'riverside'
  WHEN lower("name") = 'coastal swim school'   THEN 'coastal'
  ELSE regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g')
       || '-' || substr(replace("id"::text, '-', ''), 1, 8)
END
WHERE "slug" IS NULL;

ALTER TABLE "schools" ALTER COLUMN "slug" SET NOT NULL;

CREATE UNIQUE INDEX "schools_slug_key" ON "schools"("slug");

-- SECURITY DEFINER lookup used by `resolveTenant()`.
--
-- Why a function: the tenant resolver runs BEFORE we know which school the
-- caller belongs to, so it can't run inside an RLS-scoped transaction.
-- Granting the app role unrestricted SELECT on schools/memberships would
-- defeat RLS for those tables; instead we expose ONE narrow function that
-- returns just (school_id, role) for a (slug, user_id) pair. The function
-- is owned by the migration role (which bypasses RLS) so its body sees
-- every row, but the caller only ever gets the single matching projection.
--
-- Returning a single row with a nullable `role` lets us distinguish:
--   - 0 rows  → school not found (or soft-deleted)
--   - 1 row, role NULL → school exists, no active membership for user
--   - 1 row, role NOT NULL → membership exists; this is the success case

CREATE OR REPLACE FUNCTION app_resolve_tenant(p_slug text, p_user_id uuid)
RETURNS TABLE (school_id uuid, school_name text, role role)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.id,
    s.name,
    m.role
  FROM schools s
  LEFT JOIN memberships m
    ON m.school_id = s.id
   AND m.user_id = p_user_id
   AND m.deleted_at IS NULL
  WHERE s.slug = p_slug
    AND s.deleted_at IS NULL
$$;

REVOKE ALL ON FUNCTION app_resolve_tenant(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_tenant(text, uuid) TO swimpilot_app;

-- Listing function used by the post-sign-in landing page to figure out
-- which school(s) the user belongs to BEFORE we know what tenant context
-- to apply. Same SECURITY DEFINER reasoning as `app_resolve_tenant`:
-- narrow surface, only returns the user's own memberships.

CREATE OR REPLACE FUNCTION app_list_user_memberships(p_user_id uuid)
RETURNS TABLE (school_id uuid, slug text, name text, role role)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id, s.slug, s.name, m.role
  FROM memberships m
  JOIN schools s ON s.id = m.school_id
  WHERE m.user_id = p_user_id
    AND m.deleted_at IS NULL
    AND s.deleted_at IS NULL
  ORDER BY s.name
$$;

REVOKE ALL ON FUNCTION app_list_user_memberships(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_list_user_memberships(uuid) TO swimpilot_app;
