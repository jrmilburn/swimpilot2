# Sprint 4 / Chunk 4 — handoff

The Levels step of the post-signup onboarding wizard. Second
list-of-N step (after Locations) and the first to ship the
"apply defaults" prompt-then-list pattern that Skills (Chunk 5)
will reuse. Also the first chunk that needs a stable position-
indexed template — the four ASSA-aligned default rows are the
contract Chunk 5's skill template will key off, not their names.

## What landed

- No migration. `class_levels` was created in Sprint 3 with the
  shape this chunk needs (`name`, `ratio`, `order_index`,
  `min_age_months`, `max_age_months`, `default_progression_threshold`,
  `description`, soft-delete via `deleted_at`, audit columns,
  unique `(school_id, name)`). Kept this chunk schema-free on
  purpose; the columns were always intended for Levels.

- `src/repositories/classLevelRepository.ts` — extended in place:
  - `getById(tx, id)` now treats soft-deleted rows as missing
    (returns `null`). Same convention as `locationRepository` from
    Chunk 3.
  - `listBySchool(tx, { includeArchived } = {})` filters
    `deletedAt IS NULL` by default. **Contract change** vs.
    earlier sprints — the existing callers (`classLevels.test.ts`,
    `crossTenantClassLevel.test.ts`, `prisma/seed.ts`) never
    archive levels so they're unaffected. The future schedule
    editor / curriculum dashboard can opt back in with
    `includeArchived: true`.
  - `archive(tx, id)` — sets `deletedAt = now()`. Idempotent at
    the repository boundary; "no-op when already archived" is the
    action layer's call.
  - `reorder(tx, ids[])` — single-tx pass that writes
    `order_index` `0..n-1` in the supplied order. Validates by
    snapshotting the tenant's current non-archived id set and
    asserting count equality plus per-id membership. Both checks
    finish before any write so partial reorders are impossible.
    Throws `ValidationError` on either mismatch.
  - `mapUniqueViolation` (private) — maps Prisma `P2002` on
    `(school_id, name)` to a typed `ValidationError` keyed against
    `name`. Applied inside `create` and `update` so the action
    layer never imports Prisma. Lint enforces this — the
    `no-restricted-imports` rule blocks `@prisma/client` outside
    `src/lib/db/**` and `src/repositories/**`.

- `src/domain/assaLevelTemplate.ts` (new) — the four-row ASSA
  default template: Infants, Beginner, Intermediate, Advanced.
  `as const`. Position 0..3 is the public contract; the operator
  may rename "Beginner" to "Tadpoles" later and Chunk 5's skill
  template still resolves correctly because the lookup is by
  `orderIndex`, not by `name`. See
  `docs/architecture.md` → "Onboarding templates".

- `docs/architecture.md` — new section "Onboarding templates"
  documenting the position-not-name contract, why it's there,
  and what to do when adding a fifth ASSA row in a future sprint
  (append at position 4, never re-order; existing tenant
  templates won't shift).

- `src/app/s/[schoolSlug]/onboarding/levels/_actions/`:
  - `levelFields.ts` — shared zod fields (`LevelNameField`,
    `LevelRatioField`, `LevelProgressionThresholdField`,
    `LevelAgeMonthsField`, plus `LevelDescriptionField`). Object-
    level refinement asserts `minAgeMonths <= maxAgeMonths` and
    points the issue at `maxAgeMonths` so the field-error map
    flags the right input. `CreateLevelSchema` requires `name`
    + `ratio`; `UpdateLevelSchema` is the same fields all
    optional. Neither schema accepts `orderIndex` — the server
    owns position.
  - `addLevel(input)` — parses with `CreateLevelSchema`, computes
    `orderIndex` server-side from the live non-archived count,
    delegates to the repository, calls `revalidatePath`. Field
    errors come from the zod path map; unique-name collisions
    surface from the repository as `fieldErrors.name`.
  - `updateLevel({ id, patch })` — parses with `UpdateLevelSchema`,
    reads `getById` first for the cross-tenant 404 (RLS hides the
    row, the action surfaces it as `NotFoundError`), applies the
    partial. Unique-name collisions handled by the repository.
    `orderIndex` is intentionally not patchable here — moves go
    through `reorderLevels`.
  - `archiveLevel({ id })` — silently idempotent (`getById` null
    → `{ archived: false }`, no error). On real archive, also
    compacts the surviving rows' `order_index` to `0..n-1` via
    `reorder`, so the list never has gaps. Same defensive idiom
    as `archiveLocation`.
  - `reorderLevels({ ids })` — thin wrapper over
    `classLevelRepository.reorder`. Used by the up/down arrow
    buttons in the list view.
  - `applyAssaDefaults()` — inserts the four ASSA rows in
    template order. Refuses (typed `_form` validation error) if
    any non-archived level already exists; the prompt UI only
    renders when the list is empty so this is the concurrent-
    double-click guard. Catches the `ValidationError` the
    repository throws on a `P2002` (lost-race second click) and
    re-keys it from `fieldErrors.name` to `fieldErrors._form`
    with a friendly "Couldn't apply defaults — please try again."
    message.
  - `markLevelsComplete({ skip })` — discriminated union on
    `skip`. `skip: true` advances with status Skipped and
    persists nothing (per spec — a school may not have a settled
    level framework on day one). `skip: false` requires at least
    one non-archived level, otherwise raises a typed `_form`
    validation error. On pass, advances `current_step` to Skills
    via `onboardingProgressRepository.markStepStatus`.
  - `saveLevelsForm(schoolSlug, prev, formData)` — the
    `useActionState` bridge. Reads the `intent` button value
    (`save` | `skip`) from the form data, delegates to
    `markLevelsComplete`, redirects on success and returns the
    typed `fieldErrors` on failure.

- `src/app/s/[schoolSlug]/onboarding/levels/`:
  - `page.tsx` — server component. Loads `school` and `levels`
    in parallel inside `withTenant`. Reads `?mode=scratch` from
    the search params; when the list is empty and mode isn't
    scratch, renders `AssaDefaultPrompt`. Otherwise renders
    `LevelsList`.
  - `_components/AssaDefaultPrompt.tsx` (client) — two buttons:
    "Use ASSA defaults" calls `applyAssaDefaults` through
    `useTransition`; "Start from scratch" navigates to
    `?mode=scratch` so the empty list view renders with an
    inline editor open.
  - `_components/LevelsList.tsx` (client) — the main surface.
    Per-row up/down arrow buttons call `reorderLevels` through
    `useTransition`. Inline `LevelEditor` (not a modal) for add /
    edit. `useActionState` bridges the Continue / Skip buttons
    to `saveLevelsForm`; the `intent` button value distinguishes
    them. The Continue button is disabled when the list is empty.
  - `_components/SamplePreview.tsx` (server) — read-only "what
    parents will see" preview: a disabled `<select>` of level
    names plus the matching ratio / age range list. Renders below
    the editor so the operator gets a sense of how the framework
    reads to a customer.

- 23 integration tests across seven files:
  - `tests/integration/classLevelRepositoryFiltering.test.ts`
    (3) — `getById` returns null for soft-deleted rows;
    `listBySchool` filters by default and returns archived rows
    with `includeArchived: true`; `archive` sets `deletedAt`.
  - `tests/integration/classLevelReorder.test.ts` (3) — `reorder`
    rewrites `0..n-1`; rejects an out-of-date list (count
    mismatch); rejects a list containing an unknown id (cross-
    tenant defence beyond RLS).
  - `tests/integration/addLevel.test.ts` (5) — happy path with
    server-assigned `orderIndex`; client-supplied `orderIndex` is
    ignored; name-uniqueness collision surfaces as
    `fieldErrors.name`; min > max age rejected with
    `fieldErrors.maxAgeMonths`; cross-tenant slug 404s before
    any write.
  - `tests/integration/updateLevel.test.ts` (3) — partial update
    mutates only the supplied fields; cross-tenant id returns
    NOT_FOUND; renaming to a sibling's name surfaces
    `fieldErrors.name`.
  - `tests/integration/archiveLevel.test.ts` (2) — archive sets
    `deletedAt` and compacts surviving rows' `order_index` to
    `0..n-1`; double-archive is silently idempotent.
  - `tests/integration/reorderLevels.test.ts` (3) — happy path
    rewrites positions; out-of-date list refused; foreign id
    refused.
  - `tests/integration/applyAssaDefaults.test.ts` (3) — happy
    path inserts the four template rows in template order;
    refuses with `_form` validation error when any non-archived
    level already exists; cross-tenant slug 404s before any
    write.
  - `tests/integration/markLevelsComplete.test.ts` (4) — save
    with one level advances to Skills with status Completed;
    save with zero levels rejects with `_form` validation error;
    skip with zero levels advances with status Skipped;
    cross-tenant 404s before any read.

## Decisions worth flagging

### ASSA template position is the public contract

Chunk 5 (Skills) ships with a curated skill set per ASSA level.
The lookup has to survive the tenant renaming "Beginner" to
"Tadpoles", so the template keys off `orderIndex`, not `name`.
That makes position 0..3 a load-bearing API: insert a fifth row
in the future and **append**, never re-order, or every existing
tenant's skill mapping shifts under them. Documented in
`docs/architecture.md` → "Onboarding templates" so the next
person to touch the template doesn't have to rediscover this.

### `applyAssaDefaults` refuses on a non-empty list

We considered making it merge ("apply defaults but skip rows
whose name already exists"). Two problems: (a) what `orderIndex`
do the new rows get when the list already has, say, "My Custom
Level" at position 0 — append at the end? interleave by name? —
both answers are surprising; (b) the only UI that reaches this
action is the empty-list prompt, which by construction won't
fire on a non-empty list. The action enforces the same invariant
the UI does so a curl'd request can't get into a wedged state.
Concurrent double-click on a fresh list is handled separately:
the repository's unique-name mapping fires on the second insert
and the action re-keys it as a friendly `_form` message.

### Move via up/down arrows, not drag-and-drop

DnD costs a library (or several hundred lines of pointer-event
plumbing), keyboard-accessibility work for screen readers, and
mobile-touch handling. Up/down arrow buttons are one button each,
keyboard-native, and screen-reader-friendly out of the box.
Tenants typically have ≤ 10 levels so the clicks-to-position cost
stays tolerable. If a tenant ships with 20+ levels and the
arrows feel painful, swap in DnD without changing the action
contract — `reorderLevels` already takes the full ordering, not
a delta.

### `orderIndex` is server-owned end-to-end

The form schemas (`CreateLevelSchema`, `UpdateLevelSchema`) do
not accept `orderIndex`. Add appends at the live count;
archive compacts surviving rows; explicit moves go through
`reorderLevels`. Three reasons: (a) eliminates a class of stale-
client bugs ("the client thinks position 3 is free, but another
tab just archived position 2"); (b) the arrow UI works in terms
of swap-with-neighbour, not absolute position, so the form
field would be unused anyway; (c) keeps the unique-name
constraint as the only thing the form can collide with — one
error path, not two.

### Repository owns the Prisma `P2002` mapping

Earlier passes had the action layer catching
`Prisma.PrismaClientKnownRequestError` directly. The
`no-restricted-imports` lint rule blocks `@prisma/client` outside
`src/lib/db/**` and `src/repositories/**`, so the catch had to
move. The repository's private `mapUniqueViolation` helper
throws a typed `ValidationError({ name: "..." })` that
`addLevel` and `updateLevel` pass through unchanged.
`applyAssaDefaults` catches and re-keys the same error to
`_form` because its UX surface is the prompt, not a per-row
input. Net: the action layer is Prisma-free and the field-error
shape is consistent across all three callers.

### `archiveLevel` compacts after archive

`reorder` is called inside `archiveLevel` after the soft-delete
to rewrite the surviving rows' positions to `0..n-1`. The
alternative — leaving gaps in `order_index` — works for ordering
(the `ORDER BY` doesn't care about gaps) but breaks the
"append at live count" arithmetic in `addLevel`: after a few
archives, a fresh add could collide with an old position. The
compaction keeps the contract simple at the cost of one extra
update per surviving row, which is fine for a list of ≤ 20.

### Two entry modes via `?mode=scratch`, not state

The empty list either renders the ASSA prompt or the inline
editor. We pass the choice through the URL (`?mode=scratch`)
rather than React state so a back-button or refresh from the
editor doesn't collapse the user back to the prompt. It also
costs nothing — the page is a server component reading
`searchParams` already.

### No Chunk 1 placeholder smoke test to update

The original spec asked for the Levels route's placeholder
smoke test to be updated. There isn't one — Chunk 1 stubbed
Profile, Locations, and Billing but not the in-between steps.
Not blocking; flagging so a future sprint reading the original
spec doesn't go hunting for a test that never existed.

## What Chunk 5 plugs into

- **List-of-N + apply-defaults pattern.** Skills is the same
  shape: per-row mutations through `useTransition` +
  `revalidatePath`; Continue / Skip through `useActionState`.
  Copy `LevelsList.tsx` + the action triple
  (`add` / `update` / `archive` / `reorder`) verbatim and swap
  the entity. The ASSA-defaults prompt + scratch mode is the
  same shape too; reuse `AssaDefaultPrompt.tsx` as the template.
- **Position-indexed template lookup.** Chunk 5's curated skill
  set keys off the level's `orderIndex` (0..3), not `name`. See
  `docs/architecture.md` → "Onboarding templates" before
  writing the resolver. If the operator started from scratch
  with five custom levels, the curated skill set doesn't apply —
  fall back to "no defaults, blank list" and let them populate.
- **Soft-delete + idempotent archive.** Repository convention is
  set: `getById` filters deleted, `listBySchool` filters by
  default with `includeArchived` opt-in, `archive` sets
  `deletedAt`. Skills should mirror.
- **Repository-owned unique-violation mapping.** Skills will
  presumably have a `(level_id, name)` unique. Copy
  `mapUniqueViolation` from `classLevelRepository` and route
  the per-action error message through it.

## What's deliberately deferred

- **No reorder UX beyond up/down arrows.** Drag-and-drop is a
  polish task; the action contract (`reorderLevels({ ids })`
  takes the full ordering) won't change if we swap the UI.
- **No per-level photo / icon.** Visual differentiation in the
  parent-facing booking surface (Sprint 7) is out of scope here.
  Add a column then; the form is one input away.
- **No "rename ASSA defaults in bulk".** A tenant who wants to
  rename Beginner → Tadpoles editing one row at a time is
  acceptable for ≤ 4 rows.
- **No restore / unarchive UI.** Same as Locations.
  `listBySchool({ includeArchived: true })` is wired but no
  surface uses it.
- **No description / long-form notes editor.** The
  `description` column exists and the schema accepts it, but the
  inline editor doesn't surface it yet — pending a real customer
  ask. The schema and repository handle null cleanly.

## Verification

- `npx tsc --noEmit` is clean.
- `npm run lint` reports zero errors. (Five warnings remain,
  none new from this chunk — the same `_prev` / `_formData`
  warnings on `saveLocationsForm.ts`, the `next/image` warning
  on `ProfileForm.tsx`, and the two `_ttl` / `_paths` warnings
  on `uploadSchoolLogo.test.ts` flagged in earlier chunks.)
- All 23 chunk-4 integration tests pass against a real Postgres
  (Docker compose test stack).
- Full suite: 66 of 67 test files passing (268 of 269 tests).
  One failure, pre-existing on `main`:
  - `tests/integration/tenantRouting.test.ts > user with two
    memberships sees the picker with both schools` — `Error:
    'cookies' was called outside a request scope`. Same flag
    carried forward from Chunks 1–3.
