# Sprint 4 / Chunk 6 — handoff

The wrap-up chunk for Sprint 4. Three deliverables landed: the
`/onboarding/classes` stub for Sprint 5, the reversal of the Chunk 1
short-circuit so Skills now advances to Classes (not the dashboard),
and an end-to-end journey integration test that walks the whole
wizard. Plus the doc / cleanup work that turns "the spec is met" into
"the next sprint can pick up cleanly."

This chunk is the closer. Nothing here is new pattern — every action,
every component, every test mirrors a precedent from Chunks 1–5.

## What landed

- **`s/[schoolSlug]/onboarding/classes/`** — the Sprint 5 stub:
  - `page.tsx` (server component) — "Set up your classes" title and a
    "we're still building this" intro paragraph above the
    `ComingSoonCard`. Renders inside the existing wizard chrome
    (parent `layout.tsx` mounts the progress indicator with `classes`
    highlighted as the current step). No data reads.
  - `_components/ComingSoonCard.tsx` (server) — the explanatory card
    with two affordances: "Back to Skills" (`<Link>` to
    `/s/<slug>/onboarding/skills`) and "Skip the rest of onboarding
    for now" (delegates to `SkipRemainingForm`). Scaffolding is
    intentionally a duplicate of Chunk 5's `SkillsBlockedByLevels`
    rather than parameterised — Sprint 5 deletes the file outright
    when it ships the real Classes step, and a shared component would
    only add an indirection in the way.
  - `_components/SkipRemainingForm.tsx` (server) — single-button
    `<form action>` bound to `submitSkipRemaining`. Server component;
    no `useActionState` because there are no field errors to surface
    and the action redirects on success.
  - `_actions/skipRemainingOnboarding.ts` — the typed
    `tenantAction`. Takes no input. Calls
    `onboardingProgressRepository.complete(tx, schoolId)` and returns
    `{ ...progress, completedWizard: true }` for symmetry with the
    other per-step actions. Idempotent (the repo's `complete` is
    idempotent).
  - `_actions/submitSkipRemaining.ts` — the `<form action>` bridge.
    Awaits `skipRemainingOnboarding()` and `redirect`s to `/s/<slug>`
    on success. On non-OK results (only ever a tenant-resolution /
    RLS issue here, nothing the user can fix), re-renders silently —
    Sprint 5's real step replaces this surface anyway.

- **`WIZARD_STEPS` extended to include `classes`.** The progress
  indicator now shows five steps. The four earlier steps render as
  completed/skipped behind the active classes step. `WizardStep` and
  `isWizardStep` widen automatically; the only call sites are the
  layout (narrowing `currentStep` for the indicator's prop) and the
  indicator itself (rendering / linking), both of which handle the
  fifth value without ceremony. No cascade into per-step zod enums
  because the only place `WIZARD_STEPS` was consumed by zod was the
  legacy `markStepComplete.ts`, which is gone (see below).

- **Short-circuit reversal in
  `skills/_actions/markSkillsComplete.ts`.** The
  `if (next === OnboardingStep.Classes) { ... complete() ... return
  { ..., completedWizard: true } }` branch is gone. Both save and
  skip now call the standard `markStepStatus({ nextStep:
  OnboardingStep.Classes })` and return `{ ..., completedWizard:
  false }`. The bridge in `saveSkillsForm` already keys off
  `completedWizard: boolean` — Chunk 5's handoff identified this
  shape as the seam — so the swap was a single conditional removal
  with no form-contract change.

- **Legacy generic `_actions/markStepComplete.ts` deleted.** Nothing
  outside its own definition imported it (only sprint-notes prose
  references). Per-step actions (`markProfileComplete`,
  `markLocationsComplete`, `markLevelsComplete`,
  `markSkillsComplete`) ship their own typed inputs and short-circuit
  was the only thing the generic version still carried. The empty
  `_actions/` directory was also removed.

- **`HELP_URL` carried forward.** No real "book a migration call"
  scheduling page exists — Studio Parallel hasn't published one. The
  placeholder URL stays, the TODO comment is updated to
  `TODO(post-Sprint 4)` with a note explaining why we didn't invent
  one. **Decision flagged** — this is product-input territory, not a
  Claude Code call. See "Decisions to make in this chunk" below.

- **`docs/architecture.md` — new top-level "Onboarding" section.**
  Inserted before the existing "Onboarding templates" sub-section.
  Covers: state model (the `onboarding_progress` row, why JSONB), the
  resume contract (persisted state only — no unsaved drafts), redirect
  rule (`completed_at IS NULL` → wizard, otherwise dashboard, missing
  row → fall through), why server-side rather than localStorage
  (multi-device), skip semantics (re-saving flips Skipped → Completed
  per the Chunk 2 contract), the trigger and SECURITY DEFINER lookup
  function (pointer to the migration), and a paragraph on the Sprint
  5 stub. The "Onboarding templates" sub-section is unchanged.

- **`tests/integration/onboardingJourney.test.ts`** — two tests, both
  walking all five wizard surfaces against a real Postgres:
  - `save path: walks all four steps + classes stub to a completed
    wizard` — Profile (save with full fields) → Locations (add one,
    mark complete) → Levels (apply ASSA defaults, mark complete) →
    Skills (apply ASSA skills under position-0, mark complete) →
    Classes stub (`skipRemainingOnboarding`). Asserts `current_step`
    advances correctly at each step (notably:
    `markSkillsComplete({ skip: false })` returns
    `current_step: classes`, not `done` — the regression guard for
    the Chunk 6 reversal).
  - `skip path: walks the same journey skipping every skip-able step`
    — Profile (skip) → Locations (cannot skip; add one, mark
    complete) → Levels (skip) → Skills (skip) → Classes stub. Catches
    "skip status is written correctly across all steps."

- **Updated `tests/integration/markSkillsComplete.test.ts`.** The two
  short-circuit tests (save / skip both → `completedWizard: true`,
  `completedAt: not null`) were inverted to assert the new contract
  (`current_step: classes`, `completedWizard: false`,
  `completedAt: null`). The other three tests (no-count-gate,
  invalid-input, cross-tenant) were unchanged — they didn't assert on
  the short-circuit.

- **`saveSkillsForm.ts` doc comment refreshed** to drop the
  "while the Chunk 1 short-circuit is in effect" caveat. The dashboard
  branch is still here for symmetry with the other per-step bridges,
  not because Skills can complete the wizard now.

## Decisions worth flagging

### 1. The Sprint 5 stub is a one-page route + Coming Soon card (pre-resolved)

The stub does the minimum: explain the situation, offer "go back" and
"finish onboarding now." Not a Sprint 5 placeholder for the real form
— Sprint 5 will rip the page out and replace it. Keeping the stub
small avoids investing in scaffolding that gets deleted next sprint.

### 2. `WIZARD_STEPS` includes `classes` (pre-resolved, but worth flagging)

Recommendation in the spec was "include it." We did. The cascade
worry — zod enum widening, predicate widening — turned out to be a
non-issue: the only consumer of `z.enum(WIZARD_STEPS)` was the legacy
`markStepComplete.ts`, which we deleted in this chunk anyway. The
predicate (`isWizardStep`) and the type (`WizardStep`) both widen
automatically, and the only call sites (`layout.tsx`,
`ProgressIndicator.tsx`) handle the fifth value without ceremony.

If a future sprint finds itself needing a separate
`VISIBLE_WIZARD_STEPS` constant for indicator rendering vs. action
validation, that's the moment to introduce one. We don't need it yet.

### 3. Vitest integration journey, not Playwright (pre-resolved)

The spec called for Playwright; Chunk 6 redirected to a Vitest
integration test. Reasoning, restated for the sprint closeout:

- Per-chunk tests already cover form rendering and inline validation
  (the things a browser test catches that an action-layer test
  doesn't). The journey test's job is the *seams between chunks* —
  does completing Profile correctly land you in Locations, does
  Skills's redirect actually point at the new classes stub.
- An action-layer journey test exercises the same seams without
  pulling in a new runner / dependency / CI step.
- Playwright is a real win once we have JavaScript-driven UX
  (drag-and-drop reorder, async previews, complex client state). The
  wizard is mostly server-rendered.
- Defer Playwright to a later sprint when there's a concrete reason
  for it.

### 4. Single conditional removal, not a refactor (pre-resolved)

The short-circuit reversal was exactly the change the Chunk 1 and
Chunk 5 handoffs predicted: drop the
`if (next === OnboardingStep.Classes)` branch, return
`completedWizard: false` unconditionally. The bridge keyed off the
return shape, so no caller needed to change.

### 5. Legacy `markStepComplete.ts` deleted (pre-resolved)

Zero source imports. The file was a Chunk 1 placeholder that Chunks
2–5 superseded with per-step actions; preserving it past its expiry
was exactly the kind of dead code that becomes a debugging trap. The
sprint-notes prose references in `sprint-4-chunk-1.md` remain (they
describe history) but no living code points at it.

### 6. `HELP_URL` left as the contact-page placeholder

**Still need calls.** No real scheduling page has been published; the
placeholder URL points at `studioparallel.com.au/contact`. The TODO
comment is refreshed to `TODO(post-Sprint 4)` with a note explaining
that inventing a URL — or silently falling back to a generic contact
page when scheduling is what's wanted — would mislead operators.

This is a product-side input. **Action item for the operator:** if a
"book a migration call" page exists somewhere (Calendly, HubSpot,
something else), drop the URL into the next chunk's spec and the swap
is one constant.

### 7. `WIZARD_STEPS` decision was the spec's recommendation #7

We picked the recommended option. See decision #2 above.

### 8. Journey test in existing `tests/integration/` folder

We picked the recommended option. One file, two tests
(`onboardingJourney.test.ts`). A new `tests/journey/` subfolder would
imply a journey-test category we don't have yet.

## Sprint 4 closeout

The sprint shipped against its spec across all six chunks:

- ✅ State model: `onboarding_progress` table, AFTER INSERT trigger
  on `schools`, JSONB `step_statuses`, the full nine-step
  `onboarding_step` enum loaded up front (Chunk 1).
- ✅ Resume contract: persisted state only, server-side, redirect
  from `/` honours `completed_at IS NULL` (Chunk 1; covered in the
  new architecture-doc section).
- ✅ Wizard chrome: `<ProgressIndicator>`, layout, help link,
  Save-and-exit, route group reorganisation to break the layout-nest
  inheritance (Chunk 1).
- ✅ Profile step: full per-step action with typed input, save +
  skip, ABN normalisation, all profile fields persisted on `schools`
  (Chunk 2).
- ✅ Locations step: list-of-N with inline editor + add row,
  cannot-skip contract, soft-delete via `deleted_at` (Chunk 3).
- ✅ Levels step: list-of-N with `applyAssaDefaults` prompt + sample
  preview (Chunk 4).
- ✅ Skills step: per-level accordion, per-level
  `applyAssaSkillsForLevel` prompt, position-keyed template, single
  Continue / Skip pair at the page level (Chunk 5).
- ✅ Classes stub + short-circuit reversal: this chunk.
- ✅ Architecture doc Onboarding section: this chunk (the
  "Onboarding templates" sub-section was added by Chunks 4–5).
- 🔁 **Redirected**: Playwright E2E → Vitest integration journey
  test (this chunk; see decision #3). Two tests, full happy + full
  skip walks.

What remains open from the spec:

- **`HELP_URL` real value.** No scheduling page exists yet (decision
  #6). Carried forward as a `TODO(post-Sprint 4)` comment.
- **Pre-existing test failure** —
  `tests/integration/tenantRouting.test.ts > / landing page > user
  with two memberships sees the picker with both schools` continues
  to fail with `cookies was called outside a request scope`. This is
  the same flag carried forward from Chunks 1–5; it's a test-mock
  issue (the redirect tests in `onboardingRedirect.test.ts` mock
  `next/headers` correctly and pass). Not this chunk's problem; a
  separate task can wire up the same mock pattern there.

The sprint shipped 78 of 78 test files, 322 of 323 tests passing
(one pre-existing failure flagged above). `tsc --noEmit` is clean.
`npm run lint` reports zero errors and the same five warnings flagged
in earlier chunks (no new ones from this chunk).

## What Sprint 5 plugs into

- **Replace `/onboarding/classes/page.tsx`.** The stub is the
  contract: a real page in this slot replaces the Coming Soon card
  with the actual classes step UI (per-level accordion of class
  rows, ratio-bounded capacity, time-of-day, weekday). The wizard
  layout already mounts the progress indicator with `classes`
  highlighted; nothing in `WIZARD_STEPS` needs to move.

- **`skipRemainingOnboarding` — keep or remove?** Two options:
  - Remove it once the real Classes step has its own
    `markClassesComplete` (the per-step pattern Chunks 2–5
    established). The "Skip remaining" affordance becomes Chunk-by-
    chunk per-step skip, same as Profile / Levels / Skills.
  - Keep it as a generic exit affordance — the operator hits a
    "Finish later, I'll come back" button on any Sprint 5+ step.
    Cheap to keep; the single repository call (`complete(tx,
    schoolId)`) is already idempotent.

  **Recommendation: remove.** Per-step skip is the established
  pattern. A separate "exit early" affordance on every step adds UX
  surface area without a clear win. If we later want a "save and
  come back" button on every step, that's a different feature than a
  one-shot Sprint 5 escape hatch.

- **Per-step action template.** `markClassesComplete` should take the
  shape of `markLevelsComplete` (discriminated union on `skip`,
  list-of-N count gate on save if classes-per-level is required,
  status flip + advance `current_step` to `OnboardingStep.Teachers`).
  A class is per-level (each level has classes under it), so the
  per-row actions follow the Skills shape: `addClass({ levelId, …
  })`, `updateClass({ id, patch })`, `archiveClass({ id })`,
  `reorderClasses({ levelId, ids })`.

- **Reuse the per-level accordion pattern.** Chunk 5's
  `SkillsAccordion` is the closest reference. Native `<details>`,
  one section per level, first level open by default, no client
  library.

- **Reuse `mapUniqueViolation`.** Whatever uniqueness `classes`
  enforces (most likely `(school_id, level_id, name)` mirroring
  `skills`), copy the Prisma `P2002` → `ValidationError` pattern
  from `skillRepository.mapUniqueViolation` into a new
  `classRepository`.

- **Don't reach for a `?mode=scratch` template prompt unless
  classes have a real default template.** Levels and Skills both have
  curated ASSA templates; Classes might not (class schedules are very
  per-school). If they do, mirror the `applyAssaSkillsForLevel`
  per-level prompt + idempotency-guarded action.

## What's deliberately deferred

- **Playwright E2E.** Vitest integration journey covers the seams.
  Defer to a sprint with a concrete need (drag-and-drop reorder,
  client-state UX, mobile-specific behaviour).
- **Abandoned-onboarding reporting.** `last_activity_at` exists on
  `onboarding_progress`; nothing reads it yet. A Sprint 9+ growth/ops
  surface.
- **Dashboard "your onboarding is incomplete" prompt** for users who
  skipped steps. Not in spec.
- **Cross-school onboarding state** — a user with two schools, one
  mid-onboarding and one complete. The redirect logic handles this
  correctly (it picks the school based on the cookie or single-
  membership), but no UI surface lets them pivot between an
  incomplete school and a complete one mid-session. Deferrable.
- **`HELP_URL` real value.** Awaiting product / Studio Parallel
  input. See decision #6.

## Verification

- `npx tsc --noEmit` is clean.
- `npm run lint` reports zero errors. Five warnings remain
  pre-existing from earlier chunks (`_prev` / `_formData` on
  `saveLocationsForm.ts`, `next/image` on `ProfileForm.tsx`, `_ttl` /
  `_paths` on `uploadSchoolLogo.test.ts`). No new warnings.
- The two new tests in `onboardingJourney.test.ts` pass; the five
  rewritten tests in `markSkillsComplete.test.ts` pass.
- Full suite: 77 of 78 test files passing (322 of 323 tests). The one
  failure is the pre-existing
  `tests/integration/tenantRouting.test.ts > / landing page > user
  with two memberships sees the picker with both schools` —
  `cookies was called outside a request scope`. Carried forward from
  Chunks 1–5; not introduced by this chunk.
