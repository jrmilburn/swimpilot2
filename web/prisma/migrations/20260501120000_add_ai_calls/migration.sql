-- Sprint 3 / Chunk 6: AI scaffold logging table.
--
-- One row per AI call made through the `withAI` wrapper. Used for cost
-- monitoring, debugging, and future eval material.
--
-- Inputs are HASHED, not stored. The hash lets us correlate "this call had
-- the same inputs as that call" for debugging without persisting potentially
-- sensitive prompt content.
--
-- user_id is intentionally NOT FK-constrained: the actor who triggered an
-- AI call may eventually be deleted, but the log row should survive (cost
-- analytics, audit trail). It is indexed for per-user queries but the
-- foreign key is omitted on purpose.
--
-- Follows the Sprint 1 conventions (UUID PK, audit fields, deleted_at) and
-- the Sprint 1 RLS pattern (FORCE ROW LEVEL SECURITY + tenant_isolation
-- policy keyed on app.school_id). The wrapper throws if called outside a
-- tenant context, so the school_id column is NOT NULL.

-- CreateEnum
CREATE TYPE "ai_call_status" AS ENUM ('ok', 'error');

-- CreateTable: ai_calls
CREATE TABLE "ai_calls" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "user_id" UUID,
    "feature" TEXT NOT NULL,
    "prompt_name" TEXT NOT NULL,
    "prompt_version" INTEGER NOT NULL DEFAULT 1,
    "model" TEXT NOT NULL,
    "input_hash" TEXT NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "latency_ms" INTEGER NOT NULL,
    "status" "ai_call_status" NOT NULL,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "ai_calls_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_calls_latency_nonneg_check"
      CHECK ("latency_ms" >= 0),
    CONSTRAINT "ai_calls_input_tokens_nonneg_check"
      CHECK ("input_tokens" IS NULL OR "input_tokens" >= 0),
    CONSTRAINT "ai_calls_output_tokens_nonneg_check"
      CHECK ("output_tokens" IS NULL OR "output_tokens" >= 0)
);

-- Indexes:
--
--   1. (school_id, created_at desc) — recent activity for a tenant
--   2. (school_id, feature, created_at desc) — per-feature cost dashboards
--   3. (school_id, status) WHERE status = 'error' — surface failures fast
--   4. (school_id, user_id) — actor lookup; unenforced by FK but indexed
CREATE INDEX "ai_calls_school_id_created_at_idx"
  ON "ai_calls"("school_id", "created_at" DESC);
CREATE INDEX "ai_calls_school_id_feature_created_at_idx"
  ON "ai_calls"("school_id", "feature", "created_at" DESC);
CREATE INDEX "ai_calls_school_id_errors_idx"
  ON "ai_calls"("school_id", "created_at" DESC)
  WHERE "status" = 'error';
CREATE INDEX "ai_calls_school_id_user_id_idx"
  ON "ai_calls"("school_id", "user_id");

-- Foreign keys
--
-- school_id is FK'd; user_id is deliberately NOT (see file header).
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_school_id_fkey"
  FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Enable RLS. Same NULLIF pattern as every other tenant table so unscoped
-- reads see zero rows.
ALTER TABLE "ai_calls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_calls" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ai_calls_tenant_isolation" ON "ai_calls"
  FOR ALL
  USING ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid);
