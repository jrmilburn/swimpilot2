-- Sprint 3 / Chunk 1: Family and Student domain entities.
--
-- Tables follow the Sprint 1 conventions (UUID PKs, audit fields, deleted_at)
-- and the Sprint 1 RLS pattern (FORCE ROW LEVEL SECURITY + tenant_isolation
-- policy keyed on app.school_id). Two design notes:
--
--   1. `students.school_id` is denormalised — a student already belongs to a
--      family, and the family already has a school. We carry the school_id on
--      the student row so RLS can scope reads with no JOIN; the consistency
--      trigger `students_school_matches_family` below guarantees the value
--      cannot drift from `families.school_id`.
--
--   2. The trigger lives at the DB layer on purpose. Application-level checks
--      can be skipped by a buggy code path; a trigger cannot. See
--      docs/security.md.

-- CreateEnum
CREATE TYPE "communication_preference" AS ENUM ('email', 'sms', 'both');

-- CreateEnum
CREATE TYPE "student_status" AS ENUM ('active', 'paused', 'withdrawn');

-- CreateTable
CREATE TABLE "families" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "primary_contact_name" TEXT NOT NULL,
    "primary_contact_email" TEXT NOT NULL,
    "primary_contact_phone" TEXT,
    "address_line_1" TEXT,
    "address_line_2" TEXT,
    "suburb" TEXT,
    "state" TEXT,
    "postcode" TEXT,
    "communication_preference" "communication_preference" NOT NULL DEFAULT 'email',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "families_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "students" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "medical_notes" TEXT,
    "photo_url" TEXT,
    "status" "student_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "families_school_id_idx" ON "families"("school_id");

-- CreateIndex
CREATE INDEX "families_school_id_primary_contact_email_idx" ON "families"("school_id", "primary_contact_email");

-- CreateIndex
CREATE INDEX "students_school_id_idx" ON "students"("school_id");

-- CreateIndex
CREATE INDEX "students_family_id_idx" ON "students"("family_id");

-- CreateIndex
CREATE INDEX "students_school_id_family_id_idx" ON "students"("school_id", "family_id");

-- AddForeignKey
ALTER TABLE "families" ADD CONSTRAINT "families_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Enable RLS on the two new tables. Pattern matches locations / memberships
-- from the Sprint 1 enable_rls migration: NULLIF collapses both the
-- never-set GUC and the empty-string-after-LOCAL-revert cases to NULL, so
-- unscoped queries see zero rows instead of erroring.
ALTER TABLE "families" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "families" FORCE ROW LEVEL SECURITY;

CREATE POLICY "families_tenant_isolation" ON "families"
  FOR ALL
  USING ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid);

ALTER TABLE "students" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "students" FORCE ROW LEVEL SECURITY;

CREATE POLICY "students_tenant_isolation" ON "students"
  FOR ALL
  USING ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid);

-- students.school_id must equal families.school_id for the linked family.
-- The denormalisation exists for RLS performance (no JOIN to scope), so we
-- enforce consistency at the DB layer rather than in application code where
-- a forgotten check would silently put a student under the wrong tenant.
--
-- The trigger is SECURITY DEFINER so the lookup against `families` works
-- even when the inserting session's RLS context is the same school as the
-- new row — which it always should be — without depending on policy details
-- evolving in lockstep.
CREATE OR REPLACE FUNCTION app_assert_student_school_matches_family()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  family_school uuid;
BEGIN
  SELECT school_id INTO family_school
    FROM families
    WHERE id = NEW.family_id;

  IF family_school IS NULL THEN
    RAISE EXCEPTION
      'student family % not found', NEW.family_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF family_school <> NEW.school_id THEN
    RAISE EXCEPTION
      'student.school_id (%) must match family.school_id (%)',
      NEW.school_id, family_school
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER students_school_matches_family
  BEFORE INSERT OR UPDATE OF school_id, family_id ON students
  FOR EACH ROW
  EXECUTE FUNCTION app_assert_student_school_matches_family();
