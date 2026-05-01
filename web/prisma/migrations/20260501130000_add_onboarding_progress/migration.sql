-- Sprint 4 / Chunk 1: onboarding_progress.
--
-- One row per school recording where its admins are in the four-step (and
-- eventually ten-step) post-signup wizard. The /-landing redirect reads it
-- to decide whether to send the user to /s/<slug> or
-- /s/<slug>/onboarding/<currentStep>. A school whose `completed_at` is set
-- has finished the wizard and lands on the dashboard as today.
--
-- Conventions match Sprint 1–3: UUID PK, audit fields auto-stamped by the
-- existing extension, `deleted_at`, FORCE ROW LEVEL SECURITY scoped on
-- `app.school_id`. Cross-row creation is enforced by a SECURITY DEFINER
-- AFTER INSERT trigger on `schools` (no app-side path creates schools today
-- — they come from prisma/seed.ts and, eventually, an admin tool — so the
-- DB trigger is the only place the row is materialised).

-- 1. Step enum carries the full Sprint 4–9 set up front so we don't pay an
--    enum migration every following sprint. The wizard only renders the
--    first four (profile / locations / levels / skills) in this chunk.
CREATE TYPE "onboarding_step" AS ENUM (
  'profile',
  'locations',
  'levels',
  'skills',
  'classes',
  'teachers',
  'billing',
  'channels',
  'import',
  'done'
);

-- 2. Per-step status enum. `step_statuses` (JSONB) is keyed by step name and
--    valued by one of these. JSON over per-step columns: future Sprint 5+
--    steps cost zero schema churn, and a typed accessor in the repository
--    hides the JSON-ness from callers.
CREATE TYPE "onboarding_step_status" AS ENUM (
  'not_started',
  'in_progress',
  'completed',
  'skipped'
);

-- 3. The table. school_id is the natural PK (one row per school, enforced by
--    the unique index implied by PRIMARY KEY) and the FK target. We do not
--    add a separate UUID id — there is nothing else that references this
--    aggregate, and the school_id-as-PK keeps the AFTER-INSERT trigger
--    contract obvious (one school, one row).
--
--    `step_statuses` shape:
--      {
--        "profile":   "not_started" | "in_progress" | "completed" | "skipped",
--        "locations": "...",
--        ...one entry per onboarding_step value except "done"
--      }
--    The repository owns parsing/validating this; the DB stores the JSON as-is.
--
--    `last_activity_at` is bumped on every status mutation so future
--    "abandoned onboarding" reports have a timestamp without scanning the
--    audit fields.
CREATE TABLE "onboarding_progress" (
    "school_id" UUID NOT NULL,
    "current_step" "onboarding_step" NOT NULL DEFAULT 'profile',
    "step_statuses" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "last_activity_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "onboarding_progress_pkey" PRIMARY KEY ("school_id")
);

-- 4. FK + indexes. school_id is the PK so we get the unique index for free.
--    A secondary index on completed_at is paying for nothing today and is
--    omitted; the redirect reads by school_id only.
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. RLS. Same NULLIF pattern as every other tenant table — unscoped reads
--    return zero rows, and `WITH CHECK` on inserts/updates blocks
--    cross-tenant writes coming from app code (the AFTER-INSERT trigger
--    runs SECURITY DEFINER and bypasses this, which is intentional —
--    see the trigger's own comment for why).
ALTER TABLE "onboarding_progress" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "onboarding_progress" FORCE ROW LEVEL SECURITY;
CREATE POLICY "onboarding_progress_tenant_isolation" ON "onboarding_progress"
  FOR ALL
  USING ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid);

-- 6. Trigger: AFTER INSERT on schools, materialise the onboarding_progress
--    row. Schools today come from prisma/seed.ts; there is no user-facing
--    school-creation flow. Putting this in a Postgres trigger means future
--    school sources (admin tool, ops scripts, integration tests) all get
--    the row without remembering to insert it themselves.
--
--    SECURITY DEFINER is needed because the inserting session may have
--    `app.school_id` set to a different school than the one being created
--    (it shouldn't, but defence in depth — and seed.ts inserts unscoped).
--    The narrow function body does only what it needs.
--
--    `created_by` / `updated_by` are taken from NEW.* — the school row was
--    itself stamped by the audit extension at insert time, so we propagate
--    those values rather than re-reading AsyncLocalStorage from inside the
--    trigger (which wouldn't be available in seeds anyway).
--
--    ON CONFLICT (school_id) DO NOTHING makes the trigger safe to re-run
--    during the same migration's backfill below — the trigger fires on the
--    INSERT, then the backfill UPDATE proceeds against the row that
--    already exists.
CREATE OR REPLACE FUNCTION app_create_onboarding_progress()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO onboarding_progress (
    school_id,
    current_step,
    step_statuses,
    created_by,
    updated_by,
    updated_at
  ) VALUES (
    NEW.id,
    'profile',
    jsonb_build_object(
      'profile',   'not_started',
      'locations', 'not_started',
      'levels',    'not_started',
      'skills',    'not_started',
      'classes',   'not_started',
      'teachers',  'not_started',
      'billing',   'not_started',
      'channels',  'not_started',
      'import',    'not_started'
    ),
    NEW.created_by,
    NEW.updated_by,
    now()
  )
  ON CONFLICT (school_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER schools_create_onboarding_progress
  AFTER INSERT ON schools
  FOR EACH ROW
  EXECUTE FUNCTION app_create_onboarding_progress();

-- 7. Backfill existing schools. The trigger only fires on future INSERTs,
--    so any rows already in `schools` (in dev, in CI, in prod when this
--    deploys) need the same row created. We call the trigger function
--    inline by issuing a no-op UPDATE that touches `updated_at`? No —
--    AFTER INSERT triggers don't fire on UPDATE. Instead, do the same
--    INSERT directly here, with `ON CONFLICT DO NOTHING` so re-runs are
--    safe and the seed schools (Riverside, Coastal) end up with one row
--    each.
--
--    Then immediately mark them completed_at = NOW() with all step
--    statuses = 'completed'. Existing tests assume Riverside/Coastal users
--    land on /s/<slug>, not into a wizard — backfilling them as complete
--    keeps that contract.
INSERT INTO onboarding_progress (
  school_id,
  current_step,
  step_statuses,
  last_activity_at,
  completed_at,
  created_by,
  updated_by,
  updated_at
)
SELECT
  s.id,
  'done'::onboarding_step,
  jsonb_build_object(
    'profile',   'completed',
    'locations', 'completed',
    'levels',    'completed',
    'skills',    'completed',
    'classes',   'completed',
    'teachers',  'completed',
    'billing',   'completed',
    'channels',  'completed',
    'import',    'completed'
  ),
  now(),
  now(),
  s.created_by,
  s.updated_by,
  now()
FROM schools s
WHERE s.deleted_at IS NULL
ON CONFLICT (school_id) DO NOTHING;

-- 8. SECURITY DEFINER lookup used by the / landing page.
--
--    Same chicken-and-egg as `app_resolve_tenant`: the redirect needs to
--    read onboarding_progress BEFORE we know which school's tenant context
--    to open. RLS would return zero rows if we tried to read it inside
--    `withTenant` against the wrong school. Same seam: a narrow
--    SECURITY DEFINER function returning only the projection the redirect
--    needs.
--
--    The function returns 0 or 1 row. 0 means the school doesn't exist (or
--    is soft-deleted) — the caller handles that as "no row, no redirect
--    target". 1 row carries the current step and the completed_at marker;
--    the caller decides whether to redirect to the wizard or the dashboard
--    based on whether `completed_at IS NULL`.
CREATE OR REPLACE FUNCTION app_get_onboarding_state(p_school_id uuid)
RETURNS TABLE (
  current_step onboarding_step,
  completed_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT op.current_step, op.completed_at
  FROM onboarding_progress op
  JOIN schools s ON s.id = op.school_id
  WHERE op.school_id = p_school_id
    AND op.deleted_at IS NULL
    AND s.deleted_at IS NULL
$$;

REVOKE ALL ON FUNCTION app_get_onboarding_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_get_onboarding_state(uuid) TO swimpilot_app;
