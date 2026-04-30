-- Sprint 3 / Chunk 4: Skills and student_skills.
--
-- Two tables that establish the per-school progression curriculum and the
-- per-student record of which skills each student has achieved.
--
--   skills          — per-school per-level curriculum entries
--   student_skills  — Shape A: one row per (student, skill), mutated as the
--                     teacher updates the status. Audit fields capture who
--                     last touched it. A future student_skill_events log
--                     can be added if full progression history is wanted
--                     (Sprint 10), without disturbing this primary model.
--
-- All tables follow the Sprint 1 conventions (UUID PKs, audit fields,
-- deleted_at) and the Sprint 1 RLS pattern (FORCE ROW LEVEL SECURITY +
-- tenant_isolation policy keyed on app.school_id).
--
-- Cross-row consistency is enforced at the DB layer in the same shape used
-- in earlier chunks: BEFORE INSERT/UPDATE, SECURITY DEFINER, narrow body,
-- raise with ERRCODE 'check_violation' on divergence.

-- CreateEnum
CREATE TYPE "skill_status" AS ENUM ('not_introduced', 'working_on', 'achieved');

-- CreateTable: skills
--
-- A skill within a school's progression curriculum. Skills are scoped to a
-- level — each level has its own list. The (school_id, level_id, name)
-- unique index lets the same name reappear in another level (e.g.
-- "Streamline" in Beginner and Intermediate) while preventing duplicates
-- inside one level.
--
-- is_archived is a soft-retire flag so existing student_skills records that
-- reference a skill keep working when the school stops teaching it. The
-- listByLevel repository call filters archived out by default.
CREATE TABLE "skills" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "level_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "order_index" INTEGER NOT NULL,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable: student_skills
--
-- The per-student state of each skill. Shape A: one row per (student, skill),
-- mutated over time. Audit fields stamp who last touched it.
CREATE TABLE "student_skills" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "skill_id" UUID NOT NULL,
    "status" "skill_status" NOT NULL DEFAULT 'not_introduced',
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "student_skills_pkey" PRIMARY KEY ("id")
);

-- Indexes: skills
CREATE UNIQUE INDEX "skills_school_id_level_id_name_key"
  ON "skills"("school_id", "level_id", "name");
CREATE INDEX "skills_school_id_idx" ON "skills"("school_id");
CREATE INDEX "skills_level_id_idx" ON "skills"("level_id");
CREATE INDEX "skills_school_id_level_id_order_index_idx"
  ON "skills"("school_id", "level_id", "order_index");

-- Indexes: student_skills
CREATE UNIQUE INDEX "student_skills_student_id_skill_id_key"
  ON "student_skills"("student_id", "skill_id");
CREATE INDEX "student_skills_school_id_idx" ON "student_skills"("school_id");
CREATE INDEX "student_skills_student_id_idx" ON "student_skills"("student_id");
CREATE INDEX "student_skills_skill_id_idx" ON "student_skills"("skill_id");
CREATE INDEX "student_skills_school_id_student_id_idx"
  ON "student_skills"("school_id", "student_id");
CREATE INDEX "student_skills_school_id_skill_id_idx"
  ON "student_skills"("school_id", "skill_id");

-- Partial index for the parent progression view: "what has this student
-- achieved." Kept narrow (status = 'achieved') so the index stays small and
-- the read path is an index-only scan in the common case.
CREATE INDEX "student_skills_achieved_idx"
  ON "student_skills"("school_id", "student_id")
  WHERE "status" = 'achieved';

-- Foreign keys: skills
ALTER TABLE "skills" ADD CONSTRAINT "skills_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "skills" ADD CONSTRAINT "skills_level_id_fkey"
  FOREIGN KEY ("level_id") REFERENCES "class_levels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Foreign keys: student_skills
ALTER TABLE "student_skills" ADD CONSTRAINT "student_skills_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "student_skills" ADD CONSTRAINT "student_skills_student_id_fkey"
  FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "student_skills" ADD CONSTRAINT "student_skills_skill_id_fkey"
  FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Enable RLS on both new tables. Same NULLIF pattern as Chunks 1-3 so
-- unscoped reads see zero rows.
ALTER TABLE "skills" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skills" FORCE ROW LEVEL SECURITY;
CREATE POLICY "skills_tenant_isolation" ON "skills"
  FOR ALL
  USING ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid);

ALTER TABLE "student_skills" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "student_skills" FORCE ROW LEVEL SECURITY;
CREATE POLICY "student_skills_tenant_isolation" ON "student_skills"
  FOR ALL
  USING ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid);

-- Cross-row consistency: skills.
--   skills.school_id = class_levels.school_id (the level a skill hangs off
--   must belong to the same school).
CREATE OR REPLACE FUNCTION app_assert_skill_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  level_school uuid;
BEGIN
  SELECT school_id INTO level_school
    FROM class_levels WHERE id = NEW.level_id;
  IF level_school IS NULL THEN
    RAISE EXCEPTION
      'skill level % not found', NEW.level_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF level_school <> NEW.school_id THEN
    RAISE EXCEPTION
      'skill.school_id (%) must match level.school_id (%)',
      NEW.school_id, level_school
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER skills_consistency
  BEFORE INSERT OR UPDATE OF school_id, level_id
  ON skills
  FOR EACH ROW
  EXECUTE FUNCTION app_assert_skill_consistency();

-- Cross-row consistency: student_skills.
--   1. student_skills.school_id = students.school_id
--   2. student_skills.school_id = skills.school_id
-- The level-reachability rule (must the student be enrolled at this level?)
-- is deliberately NOT enforced here — see docs/architecture.md "Domain model
-- — Skills" for why. App-layer concern, DB stays permissive.
CREATE OR REPLACE FUNCTION app_assert_student_skill_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  student_school uuid;
  skill_school   uuid;
BEGIN
  SELECT school_id INTO student_school
    FROM students WHERE id = NEW.student_id;
  IF student_school IS NULL THEN
    RAISE EXCEPTION
      'student_skill student % not found', NEW.student_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF student_school <> NEW.school_id THEN
    RAISE EXCEPTION
      'student_skill.school_id (%) must match student.school_id (%)',
      NEW.school_id, student_school
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT school_id INTO skill_school
    FROM skills WHERE id = NEW.skill_id;
  IF skill_school IS NULL THEN
    RAISE EXCEPTION
      'student_skill skill % not found', NEW.skill_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF skill_school <> NEW.school_id THEN
    RAISE EXCEPTION
      'student_skill.school_id (%) must match skill.school_id (%)',
      NEW.school_id, skill_school
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER student_skills_consistency
  BEFORE INSERT OR UPDATE OF school_id, student_id, skill_id
  ON student_skills
  FOR EACH ROW
  EXECUTE FUNCTION app_assert_student_skill_consistency();
