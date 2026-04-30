-- Sprint 3 / Chunk 2: Class levels and classes.
--
-- ClassLevel defines a school's progression band (Infants, Beginner, ...).
-- Class is a recurring weekly slot identified by (level, day, time, location).
--
-- Both tables follow the Sprint 1 conventions (UUID PKs, audit fields,
-- deleted_at) and the RLS pattern from `enable_rls`. Time-of-day for class
-- start is stored as Postgres `time` (wall-clock in the location's
-- timezone) — recurring classes do not store UTC instants. Session-level
-- instants will live on `class_sessions` once Chunk 3 introduces it.
--
-- Three cross-row consistency rules cannot be expressed as plain CHECKs and
-- are enforced by the `app_assert_class_consistency()` BEFORE INSERT/UPDATE
-- trigger. They mirror the `students_school_matches_family` pattern from
-- Chunk 1: a SECURITY DEFINER function so the lookups bypass RLS, the
-- function body kept narrow.

-- CreateEnum
CREATE TYPE "week_day" AS ENUM ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday');

-- CreateEnum
CREATE TYPE "class_status" AS ENUM ('active', 'cancelled');

-- CreateTable
CREATE TABLE "class_levels" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ratio" INTEGER NOT NULL,
    "order_index" INTEGER NOT NULL,
    "min_age_months" INTEGER,
    "max_age_months" INTEGER,
    "default_progression_threshold" INTEGER NOT NULL DEFAULT 80,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "class_levels_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "class_levels_ratio_check" CHECK ("ratio" > 0),
    CONSTRAINT "class_levels_progression_threshold_check"
      CHECK ("default_progression_threshold" BETWEEN 0 AND 100)
);

-- CreateTable
CREATE TABLE "classes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "level_id" UUID NOT NULL,
    "teacher_id" UUID,
    "day_of_week" "week_day" NOT NULL,
    "start_time" TIME(0) NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL,
    "status" "class_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "classes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "classes_duration_check"
      CHECK ("duration_minutes" > 0 AND "duration_minutes" <= 240),
    CONSTRAINT "classes_capacity_positive_check" CHECK ("capacity" > 0)
);

-- CreateIndex
CREATE INDEX "class_levels_school_id_idx" ON "class_levels"("school_id");

-- CreateIndex
CREATE UNIQUE INDEX "class_levels_school_id_name_key" ON "class_levels"("school_id", "name");

-- CreateIndex
CREATE INDEX "classes_school_id_location_id_idx" ON "classes"("school_id", "location_id");

-- CreateIndex
CREATE INDEX "classes_school_id_level_id_idx" ON "classes"("school_id", "level_id");

-- CreateIndex
CREATE INDEX "classes_school_id_teacher_id_idx" ON "classes"("school_id", "teacher_id");

-- CreateIndex
CREATE INDEX "classes_school_id_day_of_week_start_time_idx"
  ON "classes"("school_id", "day_of_week", "start_time");

-- AddForeignKey
ALTER TABLE "class_levels" ADD CONSTRAINT "class_levels_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_level_id_fkey"
  FOREIGN KEY ("level_id") REFERENCES "class_levels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_teacher_id_fkey"
  FOREIGN KEY ("teacher_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Enable RLS on the two new tables.
ALTER TABLE "class_levels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "class_levels" FORCE ROW LEVEL SECURITY;

CREATE POLICY "class_levels_tenant_isolation" ON "class_levels"
  FOR ALL
  USING ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid);

ALTER TABLE "classes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "classes" FORCE ROW LEVEL SECURITY;

CREATE POLICY "classes_tenant_isolation" ON "classes"
  FOR ALL
  USING ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid);

-- Cross-row consistency for `classes`:
--   1. classes.school_id = locations.school_id (location belongs to same school)
--   2. classes.school_id = class_levels.school_id (level belongs to same school)
--   3. classes.capacity <= class_levels.ratio (single-teacher MVP)
--   4. if classes.teacher_id IS NOT NULL: a row in `memberships` exists where
--      user_id = teacher_id AND school_id = classes.school_id AND
--      deleted_at IS NULL. Role is not checked here — role-based authz is a
--      separate concern; this only asserts membership exists.
--
-- A trigger rather than CHECK because each rule is a join across tables.
-- SECURITY DEFINER so the lookups against `locations`, `class_levels`, and
-- `memberships` aren't filtered by the same RLS policies that gate the
-- inserting session — the tenant-isolation work is already done by the
-- WITH CHECK on `classes` itself; the trigger's job is only the join-shape
-- consistency that RLS can't express.
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

  RETURN NEW;
END;
$$;

CREATE TRIGGER classes_consistency
  BEFORE INSERT OR UPDATE OF
    school_id, location_id, level_id, teacher_id, capacity
  ON classes
  FOR EACH ROW
  EXECUTE FUNCTION app_assert_class_consistency();
