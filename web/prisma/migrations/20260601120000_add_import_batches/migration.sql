-- Sprint 5 / Chunk 2: import_batches + nullable batch_id on
-- families/students/enrolments.
--
-- The Import step's CSV importer commits each operator-confirmed CSV in
-- one transaction, then offers a rollback affordance. The unit of work
-- is the "batch": one row in `import_batches`, plus N families /
-- students / enrolments tagged with `batch_id = <batch>`. Rollback is
-- a delete-where-batch-id pass in FK order.
--
-- Choices the prompt asked us to walk through:
--
-- (a) `batch_id` on the existing tables is NULLABLE. Pre-existing rows
--     inserted by anything other than the importer (seed fixtures, the
--     manual-add UIs Sprint 6+ will land) carry NULL. Making it
--     non-null would have required backfilling every existing row with
--     a sentinel batch — that sentinel would never roll back and would
--     be permanent dead weight in the schema for a feature that only
--     applies at onboarding time. Nullable + index-on-non-null
--     (Postgres skips nulls in the b-tree by default) is the cheaper,
--     less-coupled shape.
--
-- (b) `mapping` is jsonb, not a side table. The mapping is operator-
--     supplied free-form (their CSV's column header → our target
--     field), only ever read whole, and needed for three distinct
--     things: rollback (so we know what was committed), audit (an
--     operator may want to see what mapping a past batch used), and
--     potential re-runs (Chunk 3's AI suggestions panel could re-fire
--     a previous mapping). A normalised side table would have to be
--     joined-and-pivoted every time it's read; jsonb stores the exact
--     shape the action layer hands us.
--
-- (c) `rolled_back_at timestamptz NULL` instead of a status enum. A
--     single nullable timestamp encodes both presence ("has it been
--     rolled back?") and timing ("when?") without the redundant-state
--     hazard of `status='committed' AND rolled_back_at IS NULL`. It
--     also keeps the schema small — there's no `import_batch_status`
--     enum to maintain.
--
-- (d) FK `RESTRICT` on the three child tables (families/students/
--     enrolments). Rollback must delete children before the batch row
--     to satisfy this; the repository encodes that order
--     (enrolments → students → families → batch row update). A
--     CASCADE here would let an admin DELETE silently remove all
--     imported family data — too sharp.
--
-- (e) Same RLS shape as every other tenant table — the
--     `app.school_id` GUC scopes both USING and WITH CHECK. RLS test
--     in `tests/integration/crossTenantImportBatch.test.ts` exercises
--     both sides.

-- 1. The batch row. Audit fields are NOT NULL so the audit extension
--    (DOMAIN_MODELS) auto-stamps them on insert.
CREATE TABLE "import_batches" (
    "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id"       UUID NOT NULL,
    "mapping"         JSONB NOT NULL,
    "row_count"       INTEGER NOT NULL,
    "family_count"    INTEGER NOT NULL,
    "student_count"   INTEGER NOT NULL,
    "enrolment_count" INTEGER NOT NULL,
    "committed_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rolled_back_at"  TIMESTAMPTZ(6),
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMPTZ(6) NOT NULL,
    "created_by"      UUID NOT NULL,
    "updated_by"      UUID NOT NULL,
    "deleted_at"      TIMESTAMPTZ(6),

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "import_batches_counts_nonneg_check"
      CHECK ("row_count" >= 0 AND "family_count" >= 0
             AND "student_count" >= 0 AND "enrolment_count" >= 0)
);

ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "import_batches_school_id_idx" ON "import_batches"("school_id");

-- 2. RLS. Same NULLIF pattern as every other tenant table.
ALTER TABLE "import_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_batches" FORCE ROW LEVEL SECURITY;

CREATE POLICY "import_batches_tenant_isolation" ON "import_batches"
  FOR ALL
  USING ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid);

-- 3. Add nullable batch_id to the three child tables. Index each — the
--    rollback's WHERE batch_id = ? query needs it. Partial index
--    (WHERE batch_id IS NOT NULL) keeps the index small: most rows
--    will have NULL batch_id (manually-added rows, future imports etc).
ALTER TABLE "families"
  ADD COLUMN "batch_id" UUID;
ALTER TABLE "families"
  ADD CONSTRAINT "families_batch_id_fkey"
  FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "families_batch_id_idx"
  ON "families"("batch_id") WHERE "batch_id" IS NOT NULL;

ALTER TABLE "students"
  ADD COLUMN "batch_id" UUID;
ALTER TABLE "students"
  ADD CONSTRAINT "students_batch_id_fkey"
  FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "students_batch_id_idx"
  ON "students"("batch_id") WHERE "batch_id" IS NOT NULL;

ALTER TABLE "enrolments"
  ADD COLUMN "batch_id" UUID;
ALTER TABLE "enrolments"
  ADD CONSTRAINT "enrolments_batch_id_fkey"
  FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "enrolments_batch_id_idx"
  ON "enrolments"("batch_id") WHERE "batch_id" IS NOT NULL;
