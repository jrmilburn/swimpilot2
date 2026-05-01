# Sprint 4 / Chunk 5 — handoff

The Skills step of the post-signup onboarding wizard. Third
list-of-N step (after Locations and Levels). Where Chunk 4 was a
flat list with one apply-defaults prompt, this chunk fans out to
**one accordion section per level**, each with its own ASSA
defaults prompt and its own inline list. The position-indexed
template contract Chunk 4 set up is now load-bearing.

This is also the chunk where the wizard runs out of road. The
next step in the model is Classes (Chunk 6), which doesn't have a
route yet, so saving / skipping Skills has to short-circuit
through `complete()` to land on the dashboard. That short-circuit
is reversed in Chunk 6, not here.

## What landed

- No migration. `skills` was created in Sprint 1 with the shape
  this chunk needs (`name`, `description`, `level_id`,
  `school_id`, `order_index`, `is_archived`, audit columns, the
  `(school_id, level_id, name)` unique index, and the
  `skills_consistency` trigger that enforces
  `(school_id, level_id)` consistency on insert / update).
  Notable contrast with `class_levels` and `locations`: skills
  use a boolean `is_archived` column, not `deleted_at`, because
  `student_skills` rows reference archived skills for historical
  progression and a real soft-delete with a timestamp would
  invalidate that FK.

- `src/repositories/skillRepository.ts` — extended in place:
  - `mapUniqueViolation` (private) — maps Prisma `P2002` on
    `(school_id, level_id, name)` to a typed
    `ValidationError({ name: "A skill with that name already
    exists in this level." })`. Applied inside `create` and
    `update`. The message mentions the level scope so the
    operator understands "Streamline" can collide under one
    level but not another. Mirrors `classLevelRepository`'s
    helper from Chunk 4.
  - `reorder(tx, levelId, ids[])` — single-tx pass that writes
    `order_index` `0..n-1` in the supplied order. Snapshots the
    live non-archived skills under `levelId` (RLS scopes the
    read), asserts count equality plus per-id membership, then
    runs the writes serially. Same idiom as
    `classLevelRepository.reorder` but scoped to one level —
    skills do not move between levels (the trigger fires on
    `level_id` changes, and `UpdateSkillInput` doesn't expose
    `levelId`; archive-and-recreate is the cross-level move).

- `src/domain/assaSkillTemplate.ts` (new) — the curated
  position-keyed skill set. `Record<0|1|2|3, ReadonlyArray<{
  name; description? }>>`, six-to-seven rows per level. Position
  0..3 mirrors `ASSA_LEVEL_TEMPLATE` exactly. **Position 4+ has
  no template** — a level the operator added beyond the four
  ASSA defaults sits outside the curated mapping; the action
  layer refuses to apply defaults to it (typed `_form` error)
  and the UI hides the prompt entirely. Exports a typed predicate
  `hasAssaSkillTemplate(orderIndex): orderIndex is 0|1|2|3` so
  the action narrows correctly when indexing the record.

- `docs/architecture.md` — extended the "Onboarding templates"
  section in place. Now documents both `ASSA_LEVEL_TEMPLATE` and
  `ASSA_SKILL_TEMPLATE` together: position-not-name contract,
  template-free position 4+, the `hasAssaSkillTemplate`
  predicate, and how `mapUniqueViolation` keeps the
  concurrent-double-click race compatible with the prompt UX.

- `src/app/s/[schoolSlug]/onboarding/skills/_actions/`:
  - `skillFields.ts` — shared zod fields. `SkillNameField`
    (1..100, trimmed), `SkillDescriptionField` (plain text,
    nullable, ≤ 1000). `CreateSkillSchema` includes `levelId`
    (uuid); `UpdateSkillSchema` deliberately does **not** —
    skills don't move levels via patch. Neither schema accepts
    `orderIndex`. Description is a plain `<textarea>`, not rich
    text, per the spec's "no rich text this sprint."
  - `addSkill({ levelId, name, description? })` — parses with
    `CreateSkillSchema`, reads `classLevelRepository.getById`
    first for the cross-tenant levelId 404 (RLS hides foreign
    rows; surfaces as `NotFoundError`), computes `orderIndex`
    server-side from the live non-archived count under that
    level, delegates to the repository. Unique-name collisions
    surface as `fieldErrors.name` from the repository.
  - `updateSkill({ id, patch })` — `getById` first for the
    cross-tenant 404, applies the partial. `levelId` and
    `orderIndex` not patchable here; cross-level moves go
    archive-and-recreate, position moves go through
    `reorderSkills`.
  - `archiveSkill({ id })` — silently idempotent (`getById`
    null or already archived → `{ archived: false }`). On real
    archive, sets `is_archived = true` and compacts the
    surviving siblings under the same `levelId` to `0..n-1`
    via `reorder`. Sibling levels untouched.
  - `reorderSkills({ levelId, ids })` — thin wrapper over
    `skillRepository.reorder`. Validates a non-empty `ids`
    array.
  - `applyAssaSkillsForLevel({ levelId })` — `getById` for the
    cross-tenant 404; refuses with `_form` if the level's
    `orderIndex >= 4` (no template); refuses with `_form` if any
    non-archived skill already exists under the level
    (idempotency guard mirroring `applyAssaDefaults`); inserts
    the template rows in order. Catches the
    `ValidationError({ name })` that the repository's
    `mapUniqueViolation` throws on a concurrent double-click and
    re-keys it to `{ _form: "Couldn't apply defaults — please
    try again." }`.
  - `markSkillsComplete({ skip })` — discriminated union on
    `skip`. **Both paths trigger the Chunk 1 short-circuit**
    because `nextStepAfter(Skills) === Classes` and
    `/onboarding/classes` doesn't exist yet: the action marks
    Skills with the right status (Skipped / Completed) then
    calls `onboardingProgressRepository.complete(tx, schoolId)`
    so `current_step` flips to `Done`, `completed_at` is set,
    and the bridge gets `completedWizard: true` to redirect to
    the dashboard. **Neither path requires a minimum skill
    count** — the spec explicitly allows skipping Skills, and a
    school may rationally have zero skills under some levels
    (they'll add a curriculum later).
  - `saveSkillsForm(schoolSlug, prev, formData)` — the
    `useActionState` bridge. Reads the `intent` button value
    (`save` | `skip`), calls `markSkillsComplete`, redirects to
    `/s/<slug>` on `completedWizard: true`, returns the typed
    `fieldErrors` on failure.

- `src/app/s/[schoolSlug]/onboarding/skills/`:
  - `page.tsx` — server component. Loads `levels` then per-level
    `skills` inside `withTenant`. Three branches:
    - zero levels → renders `SkillsBlockedByLevels` (a card with
      a link back to `/onboarding/levels` and a Skip-only
      `ContinueControls`).
    - 1+ levels → renders `SkillsAccordion` + `SamplePreview` +
      `ContinueControls`.
    - `?mode=scratch` is a single boolean — when present, all
      per-level prompts are suppressed and the inline editor
      opens on first render under empty levels (see
      `SkillsList.forceAddOpen`).
  - `_components/SkillsAccordion.tsx` (server) — native
    `<details>` per level; first level open by default. Per-
    level prompt rendering rules:
    - level has skills → render `SkillsList` only.
    - level empty + `?mode=scratch` → `SkillsList` with
      `forceAddOpen`.
    - level empty + has template (orderIndex 0..3) →
      `AssaSkillsPrompt` (no list).
    - level empty + no template (orderIndex 4+) → "no default
      template" hint above an inline editor.
  - `_components/SkillsList.tsx` (client) — per-level row list
    with up/down arrows, inline `SkillEditor`, per-row archive.
    Per-row mutations call their own action through
    `useTransition` and rely on `revalidatePath` to bring the
    page back to truth. Crucially, **no Continue / Skip
    buttons here** — those live at the page level via
    `ContinueControls` so the bridge can save the wizard once
    rather than once per accordion section.
  - `_components/SkillEditor.tsx` (client) — name + description
    inline editor. Plain `<textarea>` for description, no rich
    text.
  - `_components/AssaSkillsPrompt.tsx` (client) — per-level
    prompt with two buttons: "Use ASSA defaults for this level"
    (calls `applyAssaSkillsForLevel({ levelId })` via
    `useTransition`) and "Start from scratch" (links to
    `?mode=scratch`).
  - `_components/SamplePreview.tsx` (server) — read-only "what
    parents will see" card. Mocks a single student "Riley P."
    with up to four skills under the first level + status
    badges (Achieved / Working on it / Not started). No real
    student data — purely a teaching surface for the operator.
  - `_components/SkillsBlockedByLevels.tsx` (server) —
    explanatory card shown when zero levels exist; renders
    `ContinueControls` with `hideSave` so the operator can only
    skip from this state.
  - `_components/ContinueControls.tsx` (client) — the
    `useActionState` bridge with intent=save|skip buttons.
    `hideSave` prop hides the Continue button for the
    blocked-by-levels variant.

- 38 integration tests across eight files (all hit a real
  Postgres):
  - `tests/integration/skillRepositoryReorder.test.ts` (4) —
    `reorder` writes `0..n-1` in supplied order; rejects an
    out-of-date list (count mismatch); rejects an id from a
    different level (membership check); rejects an id from a
    different tenant (RLS hides B's row, the per-id check
    catches it).
  - `tests/integration/skillRepositoryUniqueViolation.test.ts`
    (3) — `create` with a duplicate name throws
    `ValidationError({ name })`; same name under a different
    level is allowed; renaming via `update` to a sibling's name
    throws.
  - `tests/integration/addSkill.test.ts` (5) — happy path with
    server-assigned `orderIndex` across two levels;
    name-uniqueness collision surfaces as `fieldErrors.name`;
    empty name returns `fieldErrors.name`; cross-school
    `levelId` returns NOT_FOUND; cross-tenant slug 404s before
    any write.
  - `tests/integration/updateSkill.test.ts` (6) — rename +
    description happy path; setting description to null
    clears it; rename collision surfaces as `fieldErrors.name`;
    unknown id returns NOT_FOUND; cross-tenant id returns
    NOT_FOUND; `levelId` smuggled into `patch` is silently
    stripped by the schema.
  - `tests/integration/archiveSkill.test.ts` (5) — happy path
    archives + compacts surviving siblings to `0..n-1`; double-
    archive is silently idempotent (`archived: false`); unknown
    id is silently idempotent; sibling levels not affected by
    the compaction; cross-tenant archive is silently a no-op.
  - `tests/integration/reorderSkills.test.ts` (5) — happy path;
    stale list returns VALIDATION; foreign-tenant id returns
    VALIDATION (membership check fires after RLS hides the
    snapshot); empty `ids` returns VALIDATION; cross-tenant slug
    404s.
  - `tests/integration/applyAssaSkillsForLevel.test.ts` (5) —
    happy path inserts the position-1 template under an empty
    Beginner level in template order; `orderIndex 4+` returns
    `_form`; non-empty level returns `_form` (idempotency
    guard); cross-school `levelId` returns NOT_FOUND;
    cross-tenant slug 404s.
  - `tests/integration/markSkillsComplete.test.ts` (5) — save
    short-circuits to `completedWizard: true` with status
    Completed and `completed_at` set; skip short-circuits to
    `completedWizard: true` with status Skipped; save with zero
    skills is allowed (no count gate); invalid input returns
    VALIDATION; cross-tenant slug 404s.

## Decisions worth flagging

### Skills uses `is_archived`, not `deleted_at`

`class_levels` and `locations` use `deleted_at` for soft-delete.
`skills` uses a boolean `is_archived` because `student_skills`
rows FK into `skills` for historical progression — a student who
achieved "Streamline" three months ago should keep that record
even after the school renames or removes the skill. A real
delete would orphan progression rows; a `deleted_at` timestamp
would imply "this row is going away" when in fact the row needs
to stay forever. The boolean is the honest spelling.
Idempotency in `archiveSkill` checks `existing.isArchived`, not
`existing.deletedAt`, accordingly.

### One accordion, one prompt per level — not a global prompt

Levels (Chunk 4) had a single ASSA prompt for the whole list.
Skills can't: each level has its own template (orderIndex 0..3),
and a tenant might have done "use defaults" on Levels but only
wants the skill defaults under three of the four (e.g. they
already have a curriculum for Advanced). One prompt per level
gives that control without a complicated diff UI. The cost is
that `applyAssaSkillsForLevel` takes `{ levelId }`, not nothing,
and the prompt component has to know which level it's for. Worth
it — `applyAssaDefaults` for skills "do all four levels at once"
would have to invent a story for "level 2 already has skills,
level 4 is custom" anyway.

### Position 4+ has no template, by design

`ASSA_SKILL_TEMPLATE` covers positions 0..3 only. A tenant who
adds a fifth level (e.g. "Squad" at orderIndex 4) gets the
"no default template" hint and has to populate it manually.
The action enforces this with `hasAssaSkillTemplate(orderIndex)`
returning false, raising `_form: "No default skills template for
this level."`. We considered "wrap around to position 3's
template" or "use position 3's template for all 4+" — both
would silently apply the wrong content, and the operator would
have to wade through deleting the wrong skills before adding
their own. The empty hint is better noise than wrong content.

### Single `?mode=scratch` boolean, not per-level

The original design considered per-level scratch (`?scratch=
levelId1,levelId2`) so an operator could skip the prompt on one
level without losing the prompt on another. Two problems: (a)
the URL gets ugly fast as the operator clicks through; (b) once
they've clicked Start From Scratch on level 1, they're going to
do it on every level — the prompt is useful when they're
deciding the framework, not after they've decided. A single
boolean covers the realistic use case at zero URL cost. Wired
through the page's `searchParams`, propagated as
`hideAllPrompts` to the accordion.

### Save / skip lives at the page level, not per-list

`SkillsList` deliberately omits the Continue / Skip buttons that
`LevelsList` had. The wizard advances **once** for Skills as a
whole, not once per level — a tenant who's added skills under
three levels and wants to skip the fourth still wants to land on
the next step, not on a partial save. `ContinueControls`
(client) holds the `useActionState` bridge once at the page
level. The per-row actions inside each accordion section run
through `useTransition` independently and rely on
`revalidatePath` to refresh.

### Markdown and rich text are deliberately out

`SkillDescriptionField` is plain text, capped at 1000 chars,
rendered in a `<textarea>` and displayed in a `<p>`. The spec
explicitly said "no rich text this sprint." A real curriculum
editor (Sprint 7?) will probably want bullet lists and bold —
add it then with a proper sanitiser, not now with an unsanitised
`dangerouslySetInnerHTML` we'd have to rip out.

### Native `<details>` accordion, no library, no React state

The accordion is server-rendered HTML (`<details><summary>`).
First level open via `open={index === 0}`; the browser preserves
open/closed state on toggle. No client component, no state
machine, no library dep. Works without JS. The cost is no
fancy animation; the win is one fewer client component to
hydrate per level.

### Save and skip both trigger the Chunk 1 short-circuit

`markSkillsComplete` short-circuits to `complete()` for both
intents because `nextStepAfter(Skills) === Classes` and the
`/onboarding/classes` route 404s in this chunk. The same shape
as Locations / Levels markStep actions. Reversing this in Chunk
6 means swapping the `if (next === OnboardingStep.Classes)`
branch for the normal `markStepStatus` call once
`/onboarding/classes` exists. The action's return shape
(`completedWizard: boolean`) is the seam — bridges read it to
choose the redirect target, so swapping won't break the form.

### Cross-tenant `levelId` returns NOT_FOUND, not VALIDATION

`addSkill` and `applyAssaSkillsForLevel` pre-check the levelId
via `classLevelRepository.getById`. RLS scopes the read so a
foreign levelId comes back null and we throw `NotFoundError`.
The `skills_consistency` trigger is the second line of defence
— it would raise a Postgres `check_violation` on a mismatched
`(school_id, level_id)` pair — but pre-checking keeps the typed
error shape rather than letting a Postgres code leak through.
Documented decision: "level not in your school" surfaces as
NOT_FOUND, not VALIDATION.

### Repository owns Prisma `P2002` mapping (continued from Chunk 4)

Same convention as `classLevelRepository`. `mapUniqueViolation`
in `skillRepository` throws `ValidationError({ name: "..." })`
on the unique-index hit; `addSkill` and `updateSkill` pass the
typed error through unchanged; `applyAssaSkillsForLevel`
catches and re-keys it to `_form` because its UX surface is the
prompt, not a per-row input. Net: the action layer remains
Prisma-free (`no-restricted-imports` lint rule still enforces
this), and the field-error shape is consistent across all
three callers.

### No Chunk 1 placeholder smoke test to update

Same flag as Chunk 4: Chunk 1 stubbed Profile, Locations, and
Billing but not the in-between steps. The
`/onboarding/skills` route had no smoke test to update. Not
blocking; carrying this forward in case a future sprint reads
the original Chunk 5 spec and goes hunting.

## What Chunk 6 plugs into

- **Reverse the Chunk 1 short-circuit.** Chunk 6 ships
  `/onboarding/classes`. At that point,
  `markSkillsComplete` should drop the
  `if (next === OnboardingStep.Classes) { ... complete() ... }`
  branch and use the standard `markStepStatus({ nextStep })`
  call. Bridges (`saveSkillsForm`) already key off
  `completedWizard: boolean`, so this swap doesn't change the
  form contract.
- **`HELP_URL` placeholder in `SkillsBlockedByLevels`.** The
  card uses a relative `/onboarding/levels` link to send the
  operator back to the previous step. If Chunk 6 introduces a
  proper help URL constant for "I'm stuck" surfaces, wire that
  here.
- **Reuse the per-level accordion pattern for Classes.** Classes
  also fans out per level (each level has classes under it),
  and the accordion + per-level inline list pattern works the
  same way. `SkillsAccordion` is the closest reference.
- **Reuse the per-row action triple.** `addSkill` /
  `updateSkill` / `archiveSkill` / `reorderSkills` are the
  template. Same wrapping (`tenantAction`), same Prisma-free
  body, same `revalidatePath` after every per-row mutation.
- **Reuse the prompt + `?mode=scratch` shape.** Whether
  Classes ships with default classes is a product question, but
  the `?mode=scratch` boolean works the same way if it does.
- **Reuse `mapUniqueViolation`.** Whatever uniqueness Classes
  enforces, copy the Prisma `P2002` → `ValidationError`
  mapping into `classRepository`. Three repositories do it now;
  it's the pattern.

## What's deliberately deferred

- **No drag-and-drop reorder.** Up/down arrows per row, same
  reasoning as Chunk 4. `reorderSkills({ levelId, ids })` takes
  the full ordering, so swapping the UI later is contract-safe.
- **No per-skill description rich-text.** Plain text only.
- **No per-skill icon, photo, or video.** Visual differentiation
  is a Sprint 7 polish task.
- **No bulk import.** Operators with a CSV-shaped curriculum
  type it in. A CSV importer is a reasonable next-sprint ask if
  this turns out to be a friction point.
- **No "use defaults across all empty levels" button.** We
  considered a one-click variant that fans out
  `applyAssaSkillsForLevel` over every empty level with a
  template. It's tractable (loop in the action) but gets
  awkward when one level fails the precondition (already
  populated; orderIndex 4+) — do you skip that level and apply
  to the rest, or refuse the whole batch? Per-level prompts
  side-step the question.
- **No restore / unarchive UI.** Same as Levels.
- **`SamplePreview` is mocked.** Renders a hardcoded "Riley P."
  card with the first level's first four skills. A real
  preview hooks into the parent surface (Sprint 7) and shows
  actual student progression.
- **No content audit on `ASSA_SKILL_TEMPLATE`.** The skill
  names and descriptions are reasonable starting points, not
  ASSA-curated copy. A swim-program subject-matter expert
  should review before this ships to real tenants.

## Verification

- `npx tsc --noEmit` is clean.
- `npm run lint` reports zero errors. (Five warnings remain,
  none new from this chunk — the same `_prev` / `_formData`
  warnings on `saveLocationsForm.ts`, the `next/image` warning
  on `ProfileForm.tsx`, and the two `_ttl` / `_paths` warnings
  on `uploadSchoolLogo.test.ts` flagged in earlier chunks.)
- All 38 chunk-5 integration tests pass against a real Postgres
  (Docker compose test stack).
- Full suite: 76 of 77 test files passing (320 of 321 tests).
  One failure, pre-existing on `main`:
  - `tests/integration/tenantRouting.test.ts > user with two
    memberships sees the picker with both schools` — `Error:
    'cookies' was called outside a request scope`. Same flag
    carried forward from Chunks 1–4.
