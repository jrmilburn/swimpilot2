-- Sprint 5 / Chunk 1: pending_invitations + classes.pending_teacher_invitation_id.
--
-- The Teachers step on the onboarding wizard introduces a third state for a
-- class's `teacher_id` slot: a Clerk invitation that has been sent but not
-- yet accepted. Until the invited user signs up and the membership is
-- finalised, the class can't carry a real `teacher_id` — but operators
-- still want to "park" the assignment so the schedule page reads as
-- intended.
--
-- We model that as a separate `pending_invitations` table plus a new
-- nullable `classes.pending_teacher_invitation_id`. A row in `classes`
-- carries at most one of (teacher_id, pending_teacher_invitation_id) —
-- once the invitation flips to `accepted` and a membership lands, an
-- atomic UPDATE swaps the columns (`teacher_id = X,
-- pending_teacher_invitation_id = NULL`).
--
-- Conventions match Sprints 1–4: UUID PK, audit fields auto-stamped by
-- the existing extension, `deleted_at`, FORCE ROW LEVEL SECURITY scoped
-- on `app.school_id`. The cross-row consistency rule (the pending
-- invitation row must belong to the same school and be in `pending`
-- status) lives on the existing `app_assert_class_consistency()`
-- trigger function — extended below.
--
-- We deliberately do NOT add a unique constraint on
-- (school_id, location_id, day_of_week, start_time) for `classes`. A
-- multi-lane pool legitimately runs concurrent classes at the same
-- (location, day, time) slot. The repository ships
-- `mapUniqueViolation` wired into create/update as a no-op — adding a
-- unique index later is a one-line migration; the mapper means the
-- action layer stays Prisma-free.

-- 1. Status enum. `pending` → invitation sent, awaiting sign-up.
--    `accepted` → user signed up and membership materialised.
--    `revoked` → operator revoked the invitation before sign-up.
--    `expired` → Clerk's TTL elapsed.
CREATE TYPE "pending_invitation_status" AS ENUM (
  'pending',
  'accepted',
  'revoked',
  'expired'
);

-- 2. The table. Carries everything we need to display the invitation in
--    the roster, finalise it on sign-up, and let the operator revoke it.
--    `clerk_invitation_id` is nullable so we can degrade gracefully if
--    the Clerk SDK call fails after the row is created — nothing here
--    blocks a row's existence on Clerk being reachable.
CREATE TABLE "pending_invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "role" NOT NULL,
    "clerk_invitation_id" TEXT,
    "invited_by_user_id" UUID NOT NULL,
    "status" "pending_invitation_status" NOT NULL DEFAULT 'pending',
    "accepted_user_id" UUID,
    "accepted_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pending_invitations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pending_invitations_email_lower_check"
      CHECK ("email" = lower("email")),
    CONSTRAINT "pending_invitations_accepted_consistency_check"
      CHECK (
        ("status" = 'accepted' AND "accepted_user_id" IS NOT NULL AND "accepted_at" IS NOT NULL)
        OR ("status" <> 'accepted')
      )
);

-- 3. Indexes. The unique partial index lets us refuse a second pending
--    invite to the same email under the same school while still allowing
--    a re-invite after revoke / expire. A revoked-then-re-invited row
--    means two `pending_invitations` rows exist; the partial WHERE keeps
--    only one as `pending` at a time.
CREATE INDEX "pending_invitations_school_id_idx" ON "pending_invitations"("school_id");
CREATE INDEX "pending_invitations_school_id_status_idx"
  ON "pending_invitations"("school_id", "status");
CREATE INDEX "pending_invitations_email_idx"
  ON "pending_invitations"(lower("email"));
CREATE UNIQUE INDEX "pending_invitations_unique_pending_per_email"
  ON "pending_invitations"("school_id", lower("email"))
  WHERE "status" = 'pending' AND "deleted_at" IS NULL;

-- 4. FKs. invited_by_user_id and accepted_user_id both target users —
--    accepted_user_id is null until acceptance lands.
ALTER TABLE "pending_invitations" ADD CONSTRAINT "pending_invitations_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pending_invitations" ADD CONSTRAINT "pending_invitations_invited_by_fkey"
  FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pending_invitations" ADD CONSTRAINT "pending_invitations_accepted_user_fkey"
  FOREIGN KEY ("accepted_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. RLS. Same NULLIF pattern as every other tenant table.
ALTER TABLE "pending_invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pending_invitations" FORCE ROW LEVEL SECURITY;

CREATE POLICY "pending_invitations_tenant_isolation" ON "pending_invitations"
  FOR ALL
  USING ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid);

-- 6. Add the new column to classes plus the FK and the mutual-exclusion
--    CHECK. The CHECK fires on the resulting row, not intermediate
--    state: a single
--      UPDATE classes SET teacher_id = X, pending_teacher_invitation_id = NULL
--    sees both new values together so the swap is atomic.
ALTER TABLE "classes"
  ADD COLUMN "pending_teacher_invitation_id" UUID;

ALTER TABLE "classes"
  ADD CONSTRAINT "classes_pending_teacher_invitation_fkey"
  FOREIGN KEY ("pending_teacher_invitation_id")
  REFERENCES "pending_invitations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "classes"
  ADD CONSTRAINT "classes_teacher_xor_pending_check"
  CHECK (
    "teacher_id" IS NULL OR "pending_teacher_invitation_id" IS NULL
  );

CREATE INDEX "classes_school_id_pending_teacher_invitation_idx"
  ON "classes"("school_id", "pending_teacher_invitation_id");

-- 7. Extend `app_assert_class_consistency()` to also validate the pending
--    invitation slot:
--    - The pending_invitations row exists.
--    - It belongs to the same school as the class.
--    - It is in `pending` status (not accepted/revoked/expired).
--    The function stays SECURITY DEFINER — same justification as the
--    existing teacher-membership check.
CREATE OR REPLACE FUNCTION app_assert_class_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  loc_school     uuid;
  level_school   uuid;
  level_ratio    int;
  membership_cnt int;
  inv_school     uuid;
  inv_status     pending_invitation_status;
  inv_deleted    timestamptz;
BEGIN
  SELECT school_id INTO loc_school
    FROM locations WHERE id = NEW.location_id;
  IF loc_school IS NULL THEN
    RAISE EXCEPTION
      'class location % not found', NEW.location_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF loc_school <> NEW.school_id THEN
    RAISE EXCEPTION
      'class.school_id (%) must match location.school_id (%)',
      NEW.school_id, loc_school
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT school_id, ratio INTO level_school, level_ratio
    FROM class_levels WHERE id = NEW.level_id;
  IF level_school IS NULL THEN
    RAISE EXCEPTION
      'class level % not found', NEW.level_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF level_school <> NEW.school_id THEN
    RAISE EXCEPTION
      'class.school_id (%) must match level.school_id (%)',
      NEW.school_id, level_school
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.capacity > level_ratio THEN
    RAISE EXCEPTION
      'class.capacity (%) cannot exceed level.ratio (%)',
      NEW.capacity, level_ratio
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.teacher_id IS NOT NULL THEN
    SELECT count(*) INTO membership_cnt
      FROM memberships
      WHERE user_id = NEW.teacher_id
        AND school_id = NEW.school_id
        AND deleted_at IS NULL;
    IF membership_cnt = 0 THEN
      RAISE EXCEPTION
        'class.teacher_id (%) is not a member of school (%)',
        NEW.teacher_id, NEW.school_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.pending_teacher_invitation_id IS NOT NULL THEN
    SELECT school_id, status, deleted_at
      INTO inv_school, inv_status, inv_deleted
      FROM pending_invitations
      WHERE id = NEW.pending_teacher_invitation_id;
    IF inv_school IS NULL THEN
      RAISE EXCEPTION
        'class pending invitation % not found',
        NEW.pending_teacher_invitation_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF inv_school <> NEW.school_id THEN
      RAISE EXCEPTION
        'class.school_id (%) must match pending_invitation.school_id (%)',
        NEW.school_id, inv_school
        USING ERRCODE = 'check_violation';
    END IF;
    IF inv_deleted IS NOT NULL THEN
      RAISE EXCEPTION
        'class pending invitation % is soft-deleted',
        NEW.pending_teacher_invitation_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF inv_status <> 'pending' THEN
      RAISE EXCEPTION
        'class pending invitation % is not in pending status (got %)',
        NEW.pending_teacher_invitation_id, inv_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 8. Re-create the trigger to extend its OF column list with
--    pending_teacher_invitation_id. Postgres does not allow ALTER TRIGGER
--    to change the column list, so we drop and recreate.
DROP TRIGGER IF EXISTS classes_consistency ON classes;
CREATE TRIGGER classes_consistency
  BEFORE INSERT OR UPDATE OF
    school_id, location_id, level_id, teacher_id, capacity,
    pending_teacher_invitation_id
  ON classes
  FOR EACH ROW
  EXECUTE FUNCTION app_assert_class_consistency();

-- 9. SECURITY DEFINER lookup used by the sign-in-redirect path's
--    `resolveAcceptedInvitation` helper. The user has just signed up via
--    a Clerk invitation; we don't yet know which school(s) they have
--    pending invitations for, so the read needs to bypass RLS. The
--    surface is intentionally narrow: it only returns rows matching
--    `lower(p_email)` AND status='pending' AND not soft-deleted, which
--    is what the helper consumes. Per-school finalisation (membership
--    upsert, invitation flip, class swap) is then performed inside a
--    normal `withTenant` transaction — RLS checks apply for those
--    writes, with `app.school_id` bound to the invitation's school.
--
--    See docs/security.md for the SECURITY DEFINER policy and why this
--    sits beside `app_resolve_tenant`/`app_list_user_memberships`.
CREATE OR REPLACE FUNCTION app_find_pending_invitations_for_email(p_email text)
RETURNS TABLE (
  invitation_id uuid,
  school_id uuid,
  role role,
  email text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id, school_id, role, email
  FROM pending_invitations
  WHERE email = lower(p_email)
    AND status = 'pending'
    AND deleted_at IS NULL;
$$;

REVOKE ALL ON FUNCTION app_find_pending_invitations_for_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_find_pending_invitations_for_email(text) TO swimpilot_app;
