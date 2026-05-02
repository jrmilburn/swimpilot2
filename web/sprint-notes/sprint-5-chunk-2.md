# Sprint 5 / Chunk 2 — handoff

The Import step's stub is gone. In its place: a real two-pane CSV
importer that parses, dry-runs, lets the operator resolve four
families of findings, commits in one transaction (tagging every
created row with `batch_id`), and exposes a one-click rollback that
deletes the batch in FK order. The wizard's "Finish setup" button
now refuses on the save path unless at least one not-rolled-back
batch exists.

This chunk introduces three pieces of architecture that hadn't
shown up before:

1. A repository function that opens a Postgres `SAVEPOINT` inside
   the `withTenant` transaction, runs the full insert pass, then
   `ROLLBACK TO SAVEPOINT` so the dry-run sees realistic row IDs
   and capacity numbers without committing anything. The pass is
   pure — both `dryRunImport` and `commitImport` call the same
   `runImportPass` driver, with one boolean controlling whether
   the batch is persisted.
2. A child-row tagging pattern: nullable `batch_id` columns on
   `families` / `students` / `enrolments`, partial-indexed
   `WHERE batch_id IS NOT NULL` so the index stays small. Rollback
   is a delete-where-batch-id pass in FK order; pre-existing rows
   (manually added, future-imports') keep `batch_id = NULL` and are
   never touched.
3. An externally-controllable `MappingPanel`. The page lifts
   `mapping` and `resolutions` state and feeds them in as `value` /
   `onChange` props; the panel does **not** call `useState` or
   `useReducer` itself. This is the seam Chunk 3's AI-suggestions
   panel needs — it will sit beside the manual mapping pane and
   call the same `setMapping` from outside. A unit test
   (`mappingPanelContract`) reads the source and rejects any
   future re-internalisation of the state.

## What landed

### Migration: `20260601120000_add_import_batches`

- New `import_batches` table: tenant-scoped, soft-deletable,
  audit-fielded, RLS'd. Carries the operator-confirmed `mapping`
  (jsonb), the four counts (`row_count` / `family_count` /
  `student_count` / `enrolment_count`), `committed_at` (default
  `now()`), and a single nullable `rolled_back_at` timestamp.
  CHECK constraint refuses negative counts.
- Nullable `batch_id` UUID column on `families`, `students`,
  `enrolments`, with FK `RESTRICT` on `import_batches(id)` and a
  partial index `WHERE batch_id IS NOT NULL` on each.
- Standard tenant RLS policy (`USING school_id = NULLIF
  current_setting('app.school_id', true), '')::uuid`, same `WITH
  CHECK`).

The migration's preamble walks every choice: nullable `batch_id`
(no sentinel batch needed for pre-existing rows), jsonb `mapping`
(only ever read whole — three use cases: rollback / audit / re-
run), `rolled_back_at` instead of a status enum, FK `RESTRICT`
not `CASCADE` (so an admin DELETE can't silently nuke imported
families), and the standard RLS shape.

### Repository: `src/repositories/importRepository.ts`

- `parseDob(value)` — accepts `YYYY-MM-DD` ISO and `DD/MM/YYYY`
  AU. Validates real calendar dates (rejects `31/02`).
- `processRow({ row, headers, mapping, resolution, lookups })` —
  pure. Returns either `{ kind: "findings"; findings }` or
  `{ kind: "insert"; findings; family; student; enrolment }`.
  Both branches carry findings — warning-level findings on
  insertable rows (capacity_breach, merge confirmation) used to
  be silently dropped; both kinds now propagate them. Implements
  all four rule families:
  - `duplicate_email` — within-batch (against earlier rows) and
    against existing families. Resolutions: `merge`, `exclude_row`.
  - `missing_required` — email / first / last are mandatory; an
    enrolment is all-or-nothing; DOB parse errors surface here.
  - `unknown_level` — case-insensitive lookup; Levenshtein ≤ 3
    suggestion via `fastest-levenshtein`. Resolutions:
    `use_suggested_level`, `exclude_enrolment`, `exclude_row`.
  - `capacity_breach` — warning. `existing + proposed + 1 > capacity`,
    where `proposed` accumulates within the batch.
- `loadLookups(db)` — one parallel `Promise.all` over class_levels,
  classes, active enrolments, and families. The class lookup keys
  by `${levelId}|${dayOfWeek}|${HH:MM}`.
- `dryRunImport(db, input)` — opens `SAVEPOINT dry_run_import`,
  runs `runImportPass(persistBatch: false)`, then `ROLLBACK TO
  SAVEPOINT` + `RELEASE SAVEPOINT` in a `finally`. Returns
  `{ findings, preview, blocking }`.
- `commitImport(db, input)` — re-validates inside a savepoint
  first; if blocking, returns `{ ok: false, report }`. Otherwise
  runs a fresh persisting pass and returns
  `{ ok: true, result: { batchId, …counts } }`.
- `runImportPass` — shared driver. Iterates rows, builds
  family / student / enrolment plans, dedupes families within the
  batch by lowercased email (or `merge:<existingId>` for merge
  resolutions). Persists in order: `import_batches` →
  `families` → `students` → `enrolments`, each tagged with
  `batch_id`.
- `rollbackImport(db, batchId)` — gets the batch (RLS hides
  cross-tenant), idempotent on `rolled_back_at != null`, deletes
  enrolments → students → families, then stamps `rolled_back_at`.
- `getById`, `listCommitted` (`rolled_back_at IS NULL AND
  deleted_at IS NULL`), `countCommitted`.

### Server actions

All in `web/src/app/s/[schoolSlug]/onboarding/import/_actions/`,
all `tenantAction`-wrapped, all Prisma-free at the action layer:

- `parseCsvAction({ csvText })` — strips UTF-8 BOM, enforces
  1 MB / 1000 row caps, returns `{ headers, rows }`. Pure (no DB
  writes), but still tenant-wrapped so a future "save the parse
  to a draft" feature can mutate without re-shaping.
- `dryRunImportAction({ rows, headers, mapping, resolutions })` —
  thin wrapper over `importRepository.dryRunImport`.
- `commitImportAction(...)` — thin wrapper over
  `importRepository.commitImport`. Returns the
  `{ ok: true | false }` discriminated union as `data`.
- `rollbackImportAction({ batchId })` — pre-checks via
  `getById` (cross-tenant 404), then calls
  `importRepository.rollbackImport`.
- `markImportComplete` (augmented) — the save path now
  pre-validates `countCommitted >= 1` and throws
  `ValidationError("Import at least one CSV before finishing —
  or skip this step.")`. Skip path unchanged.
- `saveImportForm` (augmented) — the `useActionState` bridge now
  understands six intents: `parse-csv`, `dry-run`, `commit`,
  `rollback`, `save`, `skip`. The first four return updated
  state; only `save` / `skip` redirect.

### Page: `/onboarding/import/`

- `page.tsx` — server component shell. Reads `requireTenant` and
  mounts `<ImportWorkspace />`.
- `_components/ImportWorkspace.tsx` — client component. Holds
  `csvText`, `mapping`, `resolutions` in lifted React state.
  Submits each intent through the bridge, mirrors the server's
  parsed CSV back into local state on parse, and renders three
  panes: CSV intake (file picker + textarea + sample CSV link),
  preview + mapping (left), report / commit summary (right).
  Resolution buttons (`Merge`, `Exclude row`, `Use suggested
  level`, `Skip enrolment`) update the local resolutions map; a
  fresh `dry-run` re-validates with the resolutions applied.
- `_components/MappingPanel.tsx` — externally controllable.
  Takes `headers`, `value: ImportMapping`, `onChange`, `disabled`.
  No internal source-of-truth state.
- `public/onboarding/import-sample.csv` — five-row sample with
  one within-batch family duplicate, one ISO DOB, one unknown-
  level (the operator can fix in-page) — drives a useful first
  dry-run.

### Tests

- `tests/integration/importRepository.test.ts` — full repo
  exercise: dry-run preview, each of the four rule families,
  commit-then-rollback round-trip, idempotent rollback, commit
  refusal on blocking, listCommitted / countCommitted excluding
  rolled-back batches.
- `tests/integration/importActions.test.ts` — action-layer
  smoke: parseCsv (BOM, caps, empty), dryRunImport (blocking on
  unmapped column, happy preview), commitImport + rollbackImport
  round-trip, NOT_FOUND for unknown batch.
- `tests/integration/crossTenantImportBatch.test.ts` — RLS
  isolation: scoped to A, B's batch is invisible to `getById`,
  `listCommitted`, `countCommitted`; WITH CHECK refuses
  cross-tenant inserts.
- `tests/integration/markImportComplete.test.ts` (extended) —
  save-without-batch fails validation; save-with-batch flips
  `completed_at`; skip path unchanged.
- `tests/unit/mappingPanelContract.test.ts` — compile-time
  prop-shape check + source-text guard against `useState` /
  `useReducer` re-creeping into `MappingPanel.tsx`.
- `tests/integration/onboardingJourney.test.ts` (touched) — the
  save-path journey now seeds an `import_batches` row before the
  final `markImportComplete({ skip: false })` call. The journey
  test deliberately doesn't go through the importer (covered
  separately) so it stays a thin integration test of the seams
  between chunks.

## Five decisions to flag for future-Chunk-3 / future-me

1. **SAVEPOINT inside `withTenant`'s open Prisma transaction** for
   dry-run — chosen over a nested `$transaction` (which Prisma
   serialises as a separate connection and would not see the
   tenant context already bound) and over throw-and-catch (which
   would require a wrapping `try` and lose any partial findings).
   The `SAVEPOINT` identifier is a literal in the source, so no
   injection surface. If we ever want to dry-run from a
   non-`withTenant` caller, we'll need a different strategy —
   `SAVEPOINT` requires an open outer transaction.

2. **Mapping a column to a required target but leaving the source
   cells empty** is a per-row blocking error, *not* a global
   error. Rationale: an operator may have a partly-filled CSV
   they want to import in two passes (e.g. "first import the
   families with no students, then a follow-up CSV with student
   rows"). A global error would force them to pre-clean the
   file. With a per-row error, the report tells them *which*
   rows need a value, and exclude_row gets them through.

3. **DOB parsing accepts `DD/MM/YYYY` (AU) and `YYYY-MM-DD` (ISO)**
   only. US `MM/DD/YYYY` is rejected — the AU-first product
   defaults make the locale assumption safe, but it is a hard
   default. If we add a school-level locale setting later, this
   parser is the seam to teach about it.

4. **DOB is optional in the importer; we substitute
   `1970-01-01` when missing.** The `students.date_of_birth`
   column is `NOT NULL` in the schema (and used by age-band
   logic on the dashboard), so we have to pick *something*. A
   sentinel epoch date is cheap to detect at read time and obvious
   in the UI — much better than refusing the whole row. The
   handoff calls this out so a future Chunk can either (a) make
   `date_of_birth` nullable and update the dashboard, or (b)
   force the importer to require DOB.

5. **UTF-8 BOM is stripped at the action boundary** in
   `parseCsv` (one place, by code-point check on the first
   character) rather than by teaching every header comparator
   about it. The `csv-parse` library has its own `bom: true`
   option set as a belt-and-braces — they compose correctly.

## What's deferred

- **AI suggestions panel** for column mapping. The
  `MappingPanel` is already externally controllable and
  `ImportWorkspace` lifts `mapping` state — Chunk 3 drops the
  AI panel in beside the manual pane and calls the same
  `setMapping` setter.
- **Streaming / chunked CSV ingest.** The 1 MB / 1000-row cap
  fits comfortably in one HTTP round-trip; bigger imports will
  want a job queue and a background worker (Sprint 8+).
- **Re-running a previous mapping.** `import_batches.mapping`
  is stored verbatim so the future "re-run last import" surface
  has everything it needs — but the surface itself is not built.
- **Edit-after-commit.** A committed batch can be rolled back
  but not partially edited. If an operator notices a typo on
  one row in a 200-row commit, the today-answer is "roll the
  whole batch back, fix the CSV, re-import." Sprint 6's
  manual-add UIs will cover most one-off corrections.

## What Chunk 3 plugs into

- `ImportWorkspace` lifts `mapping` and `resolutions` state and
  passes them down by `value` / `onChange`. A second pane (AI
  suggestions) can sit beside `MappingPanel` and call the same
  `setMapping` from outside.
- `import_batches.mapping` is the verbatim audit trail every
  re-run / replay surface needs.
- The four resolution kinds (`merge`, `use_suggested_level`,
  `exclude_enrolment`, `exclude_row`) are open for extension —
  add a kind to `ResolutionKind`, teach `processRow`, and the
  rest of the wiring (zod, page UI buttons) follows.

## Verification

```
prisma generate  ✓
prisma migrate   ✓ (20260601120000 applied)
tsc --noEmit     ✓ (no errors)
eslint           ✓ (5 pre-existing warnings, 0 errors)
vitest           382 / 383 passed

  The single failing test (tenantRouting "user with two
  memberships sees the picker") is the carry-forward from
  Chunk 1 — `cookies()` is called outside a request scope by
  the picker render. Confirmed by stashing this chunk's changes
  and re-running the same file: same failure on `main`. Same
  story as Chunk 1's note.
```

## Discrepancy between the prompt and the code

- The prompt referenced `levelRepository`; the actual file is
  `classLevelRepository`. The new code uses `db.classLevel`
  (Prisma) directly inside the repository, since the lookup is
  one read, parallelised with three others. No new repo function
  added.
- The prompt's bridge intent list was `parse-csv`, `dry-run`,
  `commit`, `rollback`. The bridge keeps the existing `save`
  and `skip` intents alongside, since those are the wizard's
  terminal step-advance and remain the only intents that
  redirect.

## Files touched

```
M  prisma/schema.prisma
M  src/app/s/[schoolSlug]/onboarding/import/_actions/markImportComplete.ts
M  src/app/s/[schoolSlug]/onboarding/import/_actions/saveImportForm.ts
M  src/app/s/[schoolSlug]/onboarding/import/page.tsx
M  src/domain/types.ts
M  src/lib/db/extensions.ts
M  tests/integration/markImportComplete.test.ts
M  tests/integration/onboardingJourney.test.ts
D  src/app/s/[schoolSlug]/onboarding/import/_components/ContinueControls.tsx
A  prisma/migrations/20260601120000_add_import_batches/migration.sql
A  public/onboarding/import-sample.csv
A  src/app/s/[schoolSlug]/onboarding/import/_actions/{parseCsv,dryRunImport,commitImport,rollbackImport}.ts
A  src/app/s/[schoolSlug]/onboarding/import/_components/{ImportWorkspace,MappingPanel}.tsx
A  src/repositories/importRepository.ts
A  tests/integration/{importRepository,importActions,crossTenantImportBatch}.test.ts
A  tests/unit/mappingPanelContract.test.ts
```
