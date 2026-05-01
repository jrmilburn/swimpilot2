-- Sprint 3 / Chunk 5: Billing primitives.
--
-- Schema only. No invoice generation, no Stripe integration, no credit
-- application logic — all of that is Sprint 8. The four tables here
-- (plus the per-school invoice_number counter) give Sprint 4 onboarding
-- something to write into, and Sprint 8 a complete shape to plug Stripe
-- and invoice generation into.
--
-- Money is stored as integer cents everywhere. Floats never appear on the
-- billing path. Per-line GST is snapshotted at invoice issue time
-- (immutable thereafter) so legal records survive future GST rate changes.
--
-- All four tables follow the Sprint 1 conventions (UUID PKs, audit fields,
-- deleted_at) and the Sprint 1 RLS pattern (FORCE ROW LEVEL SECURITY +
-- tenant_isolation policy keyed on app.school_id). Cross-row consistency
-- is enforced at the DB layer in the same shape used in earlier chunks:
-- BEFORE INSERT/UPDATE, SECURITY DEFINER, narrow body, raise with ERRCODE
-- 'check_violation' on divergence.

-- CreateEnum
CREATE TYPE "billing_frequency" AS ENUM ('weekly', 'fortnightly');

-- CreateEnum
CREATE TYPE "payment_method_type" AS ENUM ('card', 'becs');

-- CreateEnum
CREATE TYPE "billing_profile_status" AS ENUM ('pending_setup', 'active', 'payment_failed', 'cancelled');

-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('draft', 'issued', 'paid', 'overdue', 'void');

-- CreateEnum
CREATE TYPE "credit_source" AS ENUM ('school_cancellation', 'notified_absence', 'refund', 'manual');

-- CreateEnum
CREATE TYPE "credit_status" AS ENUM ('available', 'applied', 'expired', 'void');

-- CreateTable: billing_profiles
--
-- Exactly one billing profile per family — schema-enforced via UNIQUE on
-- family_id (not just an index). New profiles start at 'pending_setup'
-- until Sprint 8's Stripe flow promotes them to 'active'. Stripe ID
-- columns are nullable now and populated by Sprint 8.
CREATE TABLE "billing_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "billing_frequency" "billing_frequency" NOT NULL,
    "billing_anchor_date" DATE NOT NULL,
    "payment_method_type" "payment_method_type" NOT NULL,
    "stripe_customer_id" TEXT,
    "stripe_payment_method_id" TEXT,
    "status" "billing_profile_status" NOT NULL DEFAULT 'pending_setup',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "billing_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable: invoices
--
-- One invoice per family per billing period. Stored totals (subtotal /
-- gst / total) are duplicated against the line totals on purpose:
-- invoices are legal records that should be immutable once issued, and a
-- DB-level CHECK enforces total_cents = subtotal_cents + gst_cents to
-- catch drift between the line sum and the header. Status transitions
-- are NOT enforced at the DB layer — Sprint 8 owns the state machine.
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "subtotal_cents" INTEGER NOT NULL,
    "gst_cents" INTEGER NOT NULL,
    "total_cents" INTEGER NOT NULL,
    "status" "invoice_status" NOT NULL DEFAULT 'draft',
    "issued_at" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "due_at" TIMESTAMPTZ(6),
    "stripe_invoice_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invoices_period_check"
      CHECK ("period_end" >= "period_start"),
    CONSTRAINT "invoices_subtotal_nonneg_check"
      CHECK ("subtotal_cents" >= 0),
    CONSTRAINT "invoices_gst_nonneg_check"
      CHECK ("gst_cents" >= 0),
    CONSTRAINT "invoices_total_nonneg_check"
      CHECK ("total_cents" >= 0),
    CONSTRAINT "invoices_total_matches_subtotal_plus_gst_check"
      CHECK ("total_cents" = "subtotal_cents" + "gst_cents")
);

-- CreateTable: invoice_lines
--
-- Each line attributes a charge to a student and (usually) a current
-- enrolment. enrolment_id is nullable because makeup credits, manual
-- adjustments, or one-off charges might not have a current enrolment.
-- GST is snapshotted per line: amount_ex_gst_cents and gst_amount_cents
-- are written at issue time and immutable thereafter. line_total_cents
-- is stored, not computed, and a DB CHECK enforces the arithmetic.
CREATE TABLE "invoice_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "enrolment_id" UUID,
    "description" TEXT NOT NULL,
    "amount_ex_gst_cents" INTEGER NOT NULL,
    "gst_amount_cents" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "line_total_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invoice_lines_amount_nonneg_check"
      CHECK ("amount_ex_gst_cents" >= 0),
    CONSTRAINT "invoice_lines_gst_nonneg_check"
      CHECK ("gst_amount_cents" >= 0),
    CONSTRAINT "invoice_lines_quantity_positive_check"
      CHECK ("quantity" > 0),
    CONSTRAINT "invoice_lines_total_matches_check"
      CHECK ("line_total_cents" = ("amount_ex_gst_cents" + "gst_amount_cents") * "quantity")
);

-- CreateTable: credits
--
-- A credit available to a family. student_id null means family-level
-- (applies to any student); non-null pins the credit to one student.
-- amount_cents is GST-inclusive — credits apply against total_cents.
-- Source is enumerated; expires_at is nullable (no expiry).
--
-- Structural consistency: status='applied' iff applied_to_invoice_id and
-- applied_at are both set. Enforced as a CHECK constraint below using
-- equivalence between two boolean expressions; that catches "applied
-- without an invoice" and "linked to an invoice but status not applied"
-- in one line. Allowed status TRANSITIONS are NOT enforced — Sprint 8
-- owns that state machine.
CREATE TABLE "credits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "student_id" UUID,
    "amount_cents" INTEGER NOT NULL,
    "source" "credit_source" NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "status" "credit_status" NOT NULL DEFAULT 'available',
    "applied_to_invoice_id" UUID,
    "applied_at" TIMESTAMPTZ(6),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "credits_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "credits_amount_positive_check"
      CHECK ("amount_cents" > 0),
    CONSTRAINT "credits_applied_consistency_check"
      CHECK (
        ("status" = 'applied')
        =
        ("applied_to_invoice_id" IS NOT NULL AND "applied_at" IS NOT NULL)
      )
);

-- CreateTable: billing_counters
--
-- Per-school sequential allocator for human-readable invoice numbers.
-- One row per school. Sprint 8's invoice-creation flow will SELECT … FOR
-- UPDATE, increment, and write the new value back — all inside the
-- invoice-create transaction so allocation and insert are atomic. No app
-- code reads or writes this table this chunk; the row is created lazily
-- on first invoice (or eagerly by Sprint 4 onboarding alongside the
-- billing profile, depending on what's simpler).
CREATE TABLE "billing_counters" (
    "school_id" UUID NOT NULL,
    "last_invoice_number" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "billing_counters_pkey" PRIMARY KEY ("school_id"),
    CONSTRAINT "billing_counters_nonneg_check"
      CHECK ("last_invoice_number" >= 0)
);

-- Indexes: billing_profiles
--
-- Unique family_id implements the "one billing profile per family" rule
-- at the schema level, not via a regular index alone.
CREATE UNIQUE INDEX "billing_profiles_family_id_key"
  ON "billing_profiles"("family_id");
CREATE INDEX "billing_profiles_school_id_idx"
  ON "billing_profiles"("school_id");
CREATE INDEX "billing_profiles_school_id_status_idx"
  ON "billing_profiles"("school_id", "status");

-- Indexes: invoices
CREATE UNIQUE INDEX "invoices_school_id_invoice_number_key"
  ON "invoices"("school_id", "invoice_number");
CREATE INDEX "invoices_school_id_idx" ON "invoices"("school_id");
CREATE INDEX "invoices_school_id_family_id_idx"
  ON "invoices"("school_id", "family_id");
CREATE INDEX "invoices_school_id_status_due_at_idx"
  ON "invoices"("school_id", "status", "due_at");
CREATE INDEX "invoices_school_id_period_start_idx"
  ON "invoices"("school_id", "period_start");

-- Indexes: invoice_lines
--
-- The (school_id, enrolment_id) index is partial — most lines reference
-- an enrolment, but the column is nullable, and reporting queries always
-- have an enrolment_id in hand. Skipping the NULL rows keeps it small.
CREATE INDEX "invoice_lines_school_id_idx" ON "invoice_lines"("school_id");
CREATE INDEX "invoice_lines_invoice_id_idx" ON "invoice_lines"("invoice_id");
CREATE INDEX "invoice_lines_school_id_student_id_idx"
  ON "invoice_lines"("school_id", "student_id");
CREATE INDEX "invoice_lines_school_id_enrolment_id_idx"
  ON "invoice_lines"("school_id", "enrolment_id")
  WHERE "enrolment_id" IS NOT NULL;

-- Indexes: credits
--
-- Two partial indexes match the two read paths Sprint 8 cares about:
--   1. "available credits for this family right now" — invoice generation
--   2. "available credits about to expire" — expiry sweep
-- Both filter status = 'available' so the indexes stay narrow.
CREATE INDEX "credits_school_id_idx" ON "credits"("school_id");
CREATE INDEX "credits_school_id_family_id_idx"
  ON "credits"("school_id", "family_id");
CREATE INDEX "credits_available_by_family_idx"
  ON "credits"("school_id", "family_id", "status")
  WHERE "status" = 'available';
CREATE INDEX "credits_available_by_expiry_idx"
  ON "credits"("school_id", "expires_at")
  WHERE "status" = 'available';

-- Foreign keys: billing_profiles
ALTER TABLE "billing_profiles" ADD CONSTRAINT "billing_profiles_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_profiles" ADD CONSTRAINT "billing_profiles_family_id_fkey"
  FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Foreign keys: invoices
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_family_id_fkey"
  FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Foreign keys: invoice_lines
--
-- ON DELETE RESTRICT on invoice_id is deliberate: invoices are voided,
-- not deleted. Cascade-on-delete would let a careless admin nuke billing
-- history; RESTRICT forces explicit voiding via Sprint 8's flow.
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_student_id_fkey"
  FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_enrolment_id_fkey"
  FOREIGN KEY ("enrolment_id") REFERENCES "enrolments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Foreign keys: credits
ALTER TABLE "credits" ADD CONSTRAINT "credits_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credits" ADD CONSTRAINT "credits_family_id_fkey"
  FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credits" ADD CONSTRAINT "credits_student_id_fkey"
  FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credits" ADD CONSTRAINT "credits_applied_to_invoice_id_fkey"
  FOREIGN KEY ("applied_to_invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Foreign keys: billing_counters
ALTER TABLE "billing_counters" ADD CONSTRAINT "billing_counters_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Enable RLS on all four billing tables. Same NULLIF pattern as earlier
-- chunks so unscoped reads see zero rows. billing_counters is RLS-scoped
-- on school_id too — Sprint 8 allocates inside withTenant.
ALTER TABLE "billing_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_profiles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "billing_profiles_tenant_isolation" ON "billing_profiles"
  FOR ALL
  USING ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid);

ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;
CREATE POLICY "invoices_tenant_isolation" ON "invoices"
  FOR ALL
  USING ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid);

ALTER TABLE "invoice_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "invoice_lines_tenant_isolation" ON "invoice_lines"
  FOR ALL
  USING ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid);

ALTER TABLE "credits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credits" FORCE ROW LEVEL SECURITY;
CREATE POLICY "credits_tenant_isolation" ON "credits"
  FOR ALL
  USING ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid);

ALTER TABLE "billing_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY "billing_counters_tenant_isolation" ON "billing_counters"
  FOR ALL
  USING ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid);

-- Cross-row consistency: billing_profiles.
--   billing_profile.school_id = family.school_id
CREATE OR REPLACE FUNCTION app_assert_billing_profile_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  family_school uuid;
BEGIN
  SELECT school_id INTO family_school
    FROM families WHERE id = NEW.family_id;
  IF family_school IS NULL THEN
    RAISE EXCEPTION
      'billing_profile family % not found', NEW.family_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF family_school <> NEW.school_id THEN
    RAISE EXCEPTION
      'billing_profile.school_id (%) must match family.school_id (%)',
      NEW.school_id, family_school
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_profiles_consistency
  BEFORE INSERT OR UPDATE OF school_id, family_id
  ON billing_profiles
  FOR EACH ROW
  EXECUTE FUNCTION app_assert_billing_profile_consistency();

-- Cross-row consistency: invoices.
--   invoice.school_id = family.school_id
CREATE OR REPLACE FUNCTION app_assert_invoice_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  family_school uuid;
BEGIN
  SELECT school_id INTO family_school
    FROM families WHERE id = NEW.family_id;
  IF family_school IS NULL THEN
    RAISE EXCEPTION
      'invoice family % not found', NEW.family_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF family_school <> NEW.school_id THEN
    RAISE EXCEPTION
      'invoice.school_id (%) must match family.school_id (%)',
      NEW.school_id, family_school
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_consistency
  BEFORE INSERT OR UPDATE OF school_id, family_id
  ON invoices
  FOR EACH ROW
  EXECUTE FUNCTION app_assert_invoice_consistency();

-- Cross-row consistency: invoice_lines.
--   1. invoice_line.school_id = invoice.school_id
--   2. invoice_line.school_id = student.school_id
--   3. invoice_line.school_id = enrolment.school_id (if enrolment_id set)
CREATE OR REPLACE FUNCTION app_assert_invoice_line_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  invoice_school   uuid;
  student_school   uuid;
  enrolment_school uuid;
BEGIN
  SELECT school_id INTO invoice_school
    FROM invoices WHERE id = NEW.invoice_id;
  IF invoice_school IS NULL THEN
    RAISE EXCEPTION
      'invoice_line invoice % not found', NEW.invoice_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF invoice_school <> NEW.school_id THEN
    RAISE EXCEPTION
      'invoice_line.school_id (%) must match invoice.school_id (%)',
      NEW.school_id, invoice_school
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT school_id INTO student_school
    FROM students WHERE id = NEW.student_id;
  IF student_school IS NULL THEN
    RAISE EXCEPTION
      'invoice_line student % not found', NEW.student_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF student_school <> NEW.school_id THEN
    RAISE EXCEPTION
      'invoice_line.school_id (%) must match student.school_id (%)',
      NEW.school_id, student_school
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.enrolment_id IS NOT NULL THEN
    SELECT school_id INTO enrolment_school
      FROM enrolments WHERE id = NEW.enrolment_id;
    IF enrolment_school IS NULL THEN
      RAISE EXCEPTION
        'invoice_line enrolment % not found', NEW.enrolment_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF enrolment_school <> NEW.school_id THEN
      RAISE EXCEPTION
        'invoice_line.school_id (%) must match enrolment.school_id (%)',
        NEW.school_id, enrolment_school
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER invoice_lines_consistency
  BEFORE INSERT OR UPDATE OF school_id, invoice_id, student_id, enrolment_id
  ON invoice_lines
  FOR EACH ROW
  EXECUTE FUNCTION app_assert_invoice_line_consistency();

-- Cross-row consistency: credits.
--   1. credit.school_id = family.school_id
--   2. credit.school_id = student.school_id (if student_id set)
--   3. student.family_id = credit.family_id (if student_id set) —
--      a student-level credit must belong to that student's family.
--   4. credit.school_id = applied_to_invoice.school_id (if applied set)
--   5. applied_to_invoice.family_id = credit.family_id (if applied set) —
--      a credit can only be applied to its own family's invoices.
CREATE OR REPLACE FUNCTION app_assert_credit_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  family_school   uuid;
  student_school  uuid;
  student_family  uuid;
  invoice_school  uuid;
  invoice_family  uuid;
BEGIN
  SELECT school_id INTO family_school
    FROM families WHERE id = NEW.family_id;
  IF family_school IS NULL THEN
    RAISE EXCEPTION
      'credit family % not found', NEW.family_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF family_school <> NEW.school_id THEN
    RAISE EXCEPTION
      'credit.school_id (%) must match family.school_id (%)',
      NEW.school_id, family_school
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.student_id IS NOT NULL THEN
    SELECT school_id, family_id INTO student_school, student_family
      FROM students WHERE id = NEW.student_id;
    IF student_school IS NULL THEN
      RAISE EXCEPTION
        'credit student % not found', NEW.student_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF student_school <> NEW.school_id THEN
      RAISE EXCEPTION
        'credit.school_id (%) must match student.school_id (%)',
        NEW.school_id, student_school
        USING ERRCODE = 'check_violation';
    END IF;
    IF student_family <> NEW.family_id THEN
      RAISE EXCEPTION
        'credit.family_id (%) must match student.family_id (%)',
        NEW.family_id, student_family
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.applied_to_invoice_id IS NOT NULL THEN
    SELECT school_id, family_id INTO invoice_school, invoice_family
      FROM invoices WHERE id = NEW.applied_to_invoice_id;
    IF invoice_school IS NULL THEN
      RAISE EXCEPTION
        'credit applied_to_invoice % not found', NEW.applied_to_invoice_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF invoice_school <> NEW.school_id THEN
      RAISE EXCEPTION
        'credit.school_id (%) must match applied_to_invoice.school_id (%)',
        NEW.school_id, invoice_school
        USING ERRCODE = 'check_violation';
    END IF;
    IF invoice_family <> NEW.family_id THEN
      RAISE EXCEPTION
        'credit.family_id (%) must match applied_to_invoice.family_id (%)',
        NEW.family_id, invoice_family
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER credits_consistency
  BEFORE INSERT OR UPDATE OF school_id, family_id, student_id, applied_to_invoice_id
  ON credits
  FOR EACH ROW
  EXECUTE FUNCTION app_assert_credit_consistency();
