-- Sprint 4 / Chunk 2: school identity / branding fields.
--
-- Adds the eight nullable columns the profile step writes:
-- legal_name, trading_name, abn, gst_registered, primary_contact_name,
-- primary_contact_email, primary_contact_phone, logo_url. All nullable so
-- the migration is safe on existing rows (Riverside / Coastal in dev /
-- test, plus anything in prod) — the wizard fills them in step by step,
-- and a school skipping the step legitimately leaves them all NULL.
--
-- No CHECK on `abn` shape. The application validates the 11-digit AU
-- shape on write; the column stays permissive so a future relaxation
-- (NZ schools, international tenants) is a code-only change rather than
-- another migration. The trade-off is that ad-hoc writes via psql or
-- admin tooling don't get the same guard — acceptable, since those paths
-- are operator-driven.
--
-- `logo_url` stores a Storage **path** (`<school_id>/logo/<uuid>.<ext>`),
-- not a URL. The column name is kept as `logo_url` rather than
-- `logo_path` to avoid renaming a column that downstream Sprint 4 chunks
-- may already reference; the contract is documented in the architecture
-- doc and in the schoolRepository domain type.
ALTER TABLE "schools"
  ADD COLUMN "legal_name" TEXT,
  ADD COLUMN "trading_name" TEXT,
  ADD COLUMN "abn" TEXT,
  ADD COLUMN "gst_registered" BOOLEAN,
  ADD COLUMN "primary_contact_name" TEXT,
  ADD COLUMN "primary_contact_email" TEXT,
  ADD COLUMN "primary_contact_phone" TEXT,
  ADD COLUMN "logo_url" TEXT;
