-- Sprint 3 / Chunk 3: Enrolments, class sessions, and attendance.
--
-- Three tables that connect students to classes, materialise per-date
-- session instances, and record the marks against students for each session.
-- All three follow the Sprint 1 conventions (UUID PKs, audit fields,
-- deleted_at) and the Sprint 1 RLS pattern (FORCE ROW LEVEL SECURITY +
-- tenant_isolation policy keyed on app.school_id).
--
-- Cross-row consistency is enforced at the DB layer in the same shape used
-- for students_school_matches_family and classes_consistency: BEFORE
-- INSERT/UPDATE, SECURITY DEFINER, narrow body, raise with ERRCODE
-- 'check_violation' on divergence.
--
-- Lazy session materialisation: `class_sessions` rows are created on first
-- reference (attendance, cancellation) by the application's
-- `getOrCreateSession` helper, idempotent via the unique
-- (class_id, session_date) constraint.

-- CreateEnum
CREATE TYPE "enrolment_frequency" AS ENUM ('weekly', 'fortnightly_a', 'fortnightly_b', 'one_off');

-- CreateEnum
CREATE TYPE "enrolment_status" AS ENUM ('active', 'paused', 'withdrawn');

-- CreateEnum
CREATE TYPE "class_session_status" AS ENUM ('scheduled', 'cancelled', 'completed');

-- CreateEnum
CREATE TYPE "attendance_status" AS ENUM ('present', 'absent', 'late');

-- CreateTable: enrolments
--
-- Status is denormalised state derived from dates (the dates are the source
-- of truth, status is stored for query performance). The DB enforces only
-- the structural invariants — paused-implies-pause-dates-set, both-or-neither
-- on the pause window, and the simple comparisons. It deliberately does not
-- check `now()` against the pause window: that would make the table hostile
-- to time travel in tests, and the application owns transitions anyway via
-- explicit pause / resume / withdraw repository methods.
CREATE TABLE "enrolments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "frequency" "enrolment_frequency" NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "pause_from" DATE,
    "pause_to" DATE,
    "status" "enrolment_status" NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "enrolments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "enrolments_pause_both_or_neither_check"
      CHECK (("pause_from" IS NULL) = ("pause_to" IS NULL)),
    CONSTRAINT "enrolments_pause_window_check"
      CHECK ("pause_to" IS NULL OR "pause_to" >= "pause_from"),
    CONSTRAINT "enrolments_end_after_start_check"
      CHECK ("end_date" IS NULL OR "end_date" >= "start_date"),
    CONSTRAINT "enrolments_one_off_dates_check"
      CHECK ("frequency" <> 'one_off' OR "end_date" = "start_date"),
    CONSTRAINT "enrolments_paused_requires_pause_dates_check"
      CHECK ("status" <> 'paused' OR "pause_from" IS NOT NULL)
);

-- CreateTable: class_sessions
--
-- `teacher_id` is a snapshot of the class's teacher at session creation
-- time. Once written, this field is historical truth — reassigning the
-- class's teacher does not propagate to existing session rows. The
-- application's `getOrCreateSession` helper is the only writer.
CREATE TABLE "class_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "session_date" DATE NOT NULL,
    "teacher_id" UUID,
    "status" "class_session_status" NOT NULL DEFAULT 'scheduled',
    "cancellation_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "class_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable: attendance
--
-- `student_id` is denormalised onto the row alongside `enrolment_id` so the
-- record is interpretable even if the enrolment is later withdrawn or the
-- family changes. The trigger below ensures `enrolment.student_id =
-- attendance.student_id` so the two cannot drift.
CREATE TABLE "attendance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "class_session_id" UUID NOT NULL,
    "enrolment_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "status" "attendance_status" NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "attendance_pkey" PRIMARY KEY ("id")
);

-- Indexes: enrolments
CREATE INDEX "enrolments_school_id_student_id_idx" ON "enrolments"("school_id", "student_id");
CREATE INDEX "enrolments_school_id_class_id_idx" ON "enrolments"("school_id", "class_id");
CREATE INDEX "enrolments_school_id_status_idx" ON "enrolments"("school_id", "status");

-- Indexes: class_sessions
CREATE UNIQUE INDEX "class_sessions_class_id_session_date_key"
  ON "class_sessions"("class_id", "session_date");
CREATE INDEX "class_sessions_school_id_session_date_idx"
  ON "class_sessions"("school_id", "session_date");
CREATE INDEX "class_sessions_school_id_class_id_idx"
  ON "class_sessions"("school_id", "class_id");

-- Indexes: attendance
CREATE UNIQUE INDEX "attendance_class_session_id_student_id_key"
  ON "attendance"("class_session_id", "student_id");
CREATE INDEX "attendance_school_id_class_session_id_idx"
  ON "attendance"("school_id", "class_session_id");
CREATE INDEX "attendance_school_id_student_id_idx"
  ON "attendance"("school_id", "student_id");
CREATE INDEX "attendance_school_id_enrolment_id_idx"
  ON "attendance"("school_id", "enrolment_id");

-- Foreign keys: enrolments
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_student_id_fkey"
  FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_class_id_fkey"
  FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Foreign keys: class_sessions
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_class_id_fkey"
  FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_teacher_id_fkey"
  FOREIGN KEY ("teacher_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Foreign keys: attendance
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_class_session_id_fkey"
  FOREIGN KEY ("class_session_id") REFERENCES "class_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_enrolment_id_fkey"
  FOREIGN KEY ("enrolment_id") REFERENCES "enrolments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_student_id_fkey"
  FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Enable RLS on all three new tables. Same pattern as Chunks 1 and 2 —
-- NULLIF collapses both the never-set GUC and the empty-string-after-LOCAL
-- cases to NULL so unscoped reads see zero rows.
ALTER TABLE "enrolments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "enrolments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "enrolments_tenant_isolation" ON "enrolments"
  FOR ALL
  USING ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid);

ALTER TABLE "class_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "class_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "class_sessions_tenant_isolation" ON "class_sessions"
  FOR ALL
  USING ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid);

ALTER TABLE "attendance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance" FORCE ROW LEVEL SECURITY;
CREATE POLICY "attendance_tenant_isolation" ON "attendance"
  FOR ALL
  USING ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid);

-- Cross-row consistency: enrolments.
--   1. enrolments.school_id = students.school_id (student in same school)
--   2. enrolments.school_id = classes.school_id (class in same school)
-- Bundled into one trigger function for the same reason as classes_consistency
-- in Chunk 2 — single SECURITY DEFINER body, deterministic execution order.
CREATE OR REPLACE FUNCTION app_assert_enrolment_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  student_school uuid;
  class_school   uuid;
BEGIN
  SELECT school_id INTO student_school
    FROM students WHERE id = NEW.student_id;
  IF student_school IS NULL THEN
    RAISE EXCEPTION
      'enrolment student % not found', NEW.student_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF student_school <> NEW.school_id THEN
    RAISE EXCEPTION
      'enrolment.school_id (%) must match student.school_id (%)',
      NEW.school_id, student_school
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT school_id INTO class_school
    FROM classes WHERE id = NEW.class_id;
  IF class_school IS NULL THEN
    RAISE EXCEPTION
      'enrolment class % not found', NEW.class_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF class_school <> NEW.school_id THEN
    RAISE EXCEPTION
      'enrolment.school_id (%) must match class.school_id (%)',
      NEW.school_id, class_school
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enrolments_consistency
  BEFORE INSERT OR UPDATE OF school_id, student_id, class_id
  ON enrolments
  FOR EACH ROW
  EXECUTE FUNCTION app_assert_enrolment_consistency();

-- Cross-row consistency: class_sessions.
--   1. class_sessions.school_id = classes.school_id
--   2. class_sessions.session_date day-of-week = classes.day_of_week
--      (a session for a Wednesday class can't have a Tuesday session_date)
--
-- Postgres EXTRACT(DOW) returns Sunday=0..Saturday=6; we map to the
-- week_day enum order (monday-first) to compare cleanly.
CREATE OR REPLACE FUNCTION app_assert_class_session_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  class_school uuid;
  class_dow    week_day;
  session_dow  week_day;
BEGIN
  SELECT school_id, day_of_week INTO class_school, class_dow
    FROM classes WHERE id = NEW.class_id;
  IF class_school IS NULL THEN
    RAISE EXCEPTION
      'class_session class % not found', NEW.class_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF class_school <> NEW.school_id THEN
    RAISE EXCEPTION
      'class_session.school_id (%) must match class.school_id (%)',
      NEW.school_id, class_school
      USING ERRCODE = 'check_violation';
  END IF;

  session_dow := (CASE EXTRACT(DOW FROM NEW.session_date)::int
    WHEN 0 THEN 'sunday'
    WHEN 1 THEN 'monday'
    WHEN 2 THEN 'tuesday'
    WHEN 3 THEN 'wednesday'
    WHEN 4 THEN 'thursday'
    WHEN 5 THEN 'friday'
    WHEN 6 THEN 'saturday'
  END)::week_day;
  IF session_dow <> class_dow THEN
    RAISE EXCEPTION
      'class_session.session_date (% / %) must fall on class.day_of_week (%)',
      NEW.session_date, session_dow, class_dow
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER class_sessions_consistency
  BEFORE INSERT OR UPDATE OF school_id, class_id, session_date
  ON class_sessions
  FOR EACH ROW
  EXECUTE FUNCTION app_assert_class_session_consistency();

-- Cross-row consistency: attendance.
--   1. enrolment.school_id = attendance.school_id
--   2. class_session.school_id = attendance.school_id
--   3. student.school_id = attendance.school_id
--   4. enrolment.student_id = attendance.student_id (the attendance is
--      against the student named on the enrolment, not a different one)
CREATE OR REPLACE FUNCTION app_assert_attendance_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  enrol_school   uuid;
  enrol_student  uuid;
  session_school uuid;
  student_school uuid;
BEGIN
  SELECT school_id, student_id INTO enrol_school, enrol_student
    FROM enrolments WHERE id = NEW.enrolment_id;
  IF enrol_school IS NULL THEN
    RAISE EXCEPTION
      'attendance enrolment % not found', NEW.enrolment_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF enrol_school <> NEW.school_id THEN
    RAISE EXCEPTION
      'attendance.school_id (%) must match enrolment.school_id (%)',
      NEW.school_id, enrol_school
      USING ERRCODE = 'check_violation';
  END IF;
  IF enrol_student <> NEW.student_id THEN
    RAISE EXCEPTION
      'attendance.student_id (%) must match enrolment.student_id (%)',
      NEW.student_id, enrol_student
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT school_id INTO session_school
    FROM class_sessions WHERE id = NEW.class_session_id;
  IF session_school IS NULL THEN
    RAISE EXCEPTION
      'attendance class_session % not found', NEW.class_session_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF session_school <> NEW.school_id THEN
    RAISE EXCEPTION
      'attendance.school_id (%) must match class_session.school_id (%)',
      NEW.school_id, session_school
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT school_id INTO student_school
    FROM students WHERE id = NEW.student_id;
  IF student_school IS NULL THEN
    RAISE EXCEPTION
      'attendance student % not found', NEW.student_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF student_school <> NEW.school_id THEN
    RAISE EXCEPTION
      'attendance.school_id (%) must match student.school_id (%)',
      NEW.school_id, student_school
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER attendance_consistency
  BEFORE INSERT OR UPDATE OF school_id, class_session_id, enrolment_id, student_id
  ON attendance
  FOR EACH ROW
  EXECUTE FUNCTION app_assert_attendance_consistency();
