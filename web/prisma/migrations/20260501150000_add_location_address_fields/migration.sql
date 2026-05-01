-- Sprint 4 / Chunk 3: location address + notes columns.
--
-- Adds five nullable columns to `locations` so the onboarding Locations
-- step can capture a single-line address, suburb, state, postcode, and
-- free-text notes per pool / venue. All nullable — name remains the only
-- required field, and the migration is safe on existing rows.
--
-- Why no CHECK constraints (postcode shape, AU-state enum, etc.):
-- the Sprint 4 spec is AU-first, not AU-only. A future NZ school would
-- need to rework an `au_state` enum, and AU postcodes (4 digits) sit in
-- the same shape-validation bucket as the ABN column from Chunk 2 — the
-- DB stays permissive, app-side zod validation enforces the shape, and
-- ad-hoc admin-tool writes don't get the same guard (acceptable, those
-- paths are operator-driven).
--
-- `timezone` is already nullable on `locations` from the init migration;
-- this chunk does not touch that contract. The application defaults the
-- form value to the parent school's timezone when blank; persisting null
-- means "uses school timezone" and reads compose with school.timezone at
-- render. Keeping the column nullable preserves that affordance.
--
-- The existing `locations_school_id_idx` from the init migration covers
-- the listBySchool read path; nothing to add here.
ALTER TABLE "locations"
  ADD COLUMN "address_line" TEXT,
  ADD COLUMN "suburb" TEXT,
  ADD COLUMN "state" TEXT,
  ADD COLUMN "postcode" TEXT,
  ADD COLUMN "notes" TEXT;
