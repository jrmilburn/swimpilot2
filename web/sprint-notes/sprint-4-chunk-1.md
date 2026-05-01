# Sprint 4 / Chunk 1 — handoff

State model + redirect plumbing for the post-signup onboarding wizard.
Form bodies are deliberately placeholders this chunk; Chunks 2–5 fill
them in.

## What landed

- Migration `20260501130000_add_onboarding_progress`:
  - `onboarding_step` enum carrying the full Sprint 4–9 set up front
    (`profile | locations | levels | skills | classes | teachers |
    billing | channels | import | done`) so subsequent chunks don't
    need an enum migration each time.
  - `onboarding_step_status` enum (`not_started | in_progress |
    completed | skipped`).
  - `onboarding_progress` table — `school_id` is the natural PK (one
    row per school), `step_statuses` is `JSONB` keyed by step name,
    plus `current_step`, `last_activity_at`, `completed_at`, the
    standard audit columns, and `deleted_at`. FK to `schools` with
    `ON DELETE RESTRICT`.
  - `FORCE ROW LEVEL SECURITY` with the same `NULLIF
    current_setting('app.school_id') :: uuid` policy as every other
    tenant table.
  - `app_create_onboarding_progress()` SECURITY DEFINER trigger
    function, fired AFTER INSERT on `schools`. Stamps `created_by` /
    `updated_by` from `NEW.*`, `ON CONFLICT (school_id) DO NOTHING`
    so the migration's own backfill UPDATE is safe to re-run.
  - Backfill INSERT for existing schools (Riverside, Coastal in dev /
    test) marking them `current_step = 'done'`,
    `completed_at = now()`, all step statuses `completed` — preserves
    the existing test contract that those schools land on the
    dashboard, not the wizard.
  - `app_get_onboarding_state(p_school_id uuid)` SECURITY DEFINER
    function returning `(current_step, completed_at)`. Joins
    `schools` so soft-deleted schools return zero rows. `EXECUTE`
    granted to `swimpilot_app` only.
- `OnboardingStep` and `OnboardingStepStatus` const objects in
  `src/domain/enums.ts`, mirroring the DB enum values byte-for-byte.
  `OnboardingProgress` model + `onboardingProgress` relation on
  `School` in `prisma/schema.prisma`. `OnboardingProgress` added to
  the `DOMAIN_MODELS` set in `src/lib/db/extensions.ts` so the audit
  extension stamps `created_by` / `updated_by`.
- `src/domain/onboarding.ts`:
  - `ONBOARDING_STEP_ORDER` — editorial 9-step ordering excluding
    `done` (the DB enum sorts alphabetically; wizard order is decided
    in TS).
  - `WIZARD_STEPS` — the four steps the wizard chrome actually
    renders this chunk (`profile`, `locations`, `levels`, `skills`).
  - `OnboardingStepCode` (full 9-step union) and `WizardStep` (narrow
    4-step union — the type of an item in `WIZARD_STEPS`). Two
    separate names so reasoning that's wizard-only doesn't accidentally
    leak future-step values.
  - `WIZARD_STEP_LABELS` — `Record<OnboardingStepCode, string>` so
    the labels are ready when later chunks turn on more steps.
  - `isWizardStep(value)` predicate, `nextStepAfter(step)` (returns
    `OnboardingStep.Done` past the end), `StepStatusMap` JSON shape.
- `src/repositories/onboardingProgressRepository.ts`:
  - `getBySchool(db, schoolId)` returns `OnboardingProgress | null`.
  - `markStepStatus(db, { schoolId, step, status, nextStep? })`
    merges into the JSONB map, optionally advances `current_step`,
    bumps `last_activity_at`. Throws `NotFoundError` if the row
    doesn't exist (auto-creating would paper over a trigger bug —
    see "Decisions" below).
  - `complete(db, schoolId)` sets `completed_at = now()`,
    `current_step = done`, idempotent.
  - JSONB parse is permissive (drops unknown keys, falls back to
    `not_started` for unknown values) so a hand-edited row never
    crashes the redirect path.
- `src/repositories/tenantRepository.ts` extended with
  `getOnboardingRedirectState(schoolId)` — `$queryRaw` against
  `app_get_onboarding_state(uuid)` on the base prisma client. Same
  shape as `lookupTenant` / `listUserMemberships`; runs before any
  tenant context is open.
- `/` landing page (`src/app/page.tsx`) gained a `redirectToSchool`
  helper. Single-membership and cookie-match paths both go through
  it. Schools whose `completed_at IS NULL` redirect to
  `/s/<slug>/onboarding/<currentStep>`; complete schools redirect to
  `/s/<slug>` as before. Missing onboarding row falls through to the
  dashboard — see "Decisions".
- Wizard chrome at `s/[schoolSlug]/onboarding/`:
  - `layout.tsx` — title, help link (placeholder URL pointing at the
    Studio Parallel contact page; flagged for replacement), Save and
    exit, `<ProgressIndicator>`. Reads `onboarding_progress` inside
    `withTenant` so RLS scopes the lookup. Throws if the row is
    missing.
  - `_components/ProgressIndicator.tsx` — server-rendered ordered
    list. Completed / skipped / past-but-current steps render as
    `<Link>`; the current step is `aria-current="step"` and not a
    link; future steps are visually disabled. No client JS.
  - `_actions/markStepComplete.ts` — single generic action wrapped
    in `tenantAction`. Validates with `z.enum(WIZARD_STEPS)`, marks
    the step `completed`, advances `current_step` to
    `nextStepAfter(step)`. Includes a Chunk-1-only short-circuit
    that calls `complete()` instead when the next step would be
    `classes` — see "Decisions". Returns
    `{ ...row, completedWizard: boolean }` so the caller knows
    whether to redirect to the dashboard.
  - Four placeholder pages (`profile/`, `locations/`, `levels/`,
    `skills/`) each rendering "Step N: <name> — coming in Chunk N"
    plus a `<form action>` calling `markStepComplete`. The form
    action handler decides the redirect target: `/s/<slug>` when
    `completedWizard: true`, otherwise
    `/s/<slug>/onboarding/<nextStep>`.
- `s/[schoolSlug]/(dashboard)/` route group — see "Decisions" for
  why the existing dashboard files were moved here. The files
  themselves (`layout.tsx`, `page.tsx`, `_actions/`, `_components/`)
  are unchanged in content.
- 15 integration tests across four files:
  - `onboardingProgressTrigger.test.ts` — trigger materialises the
    row with the right defaults; backfill leaves Riverside / Coastal
    completed; duplicate school INSERT is rejected at the schools PK
    so the trigger doesn't double-fire.
  - `onboardingProgressRepository.test.ts` — `getBySchool`,
    `markStepStatus` with and without `nextStep`, `complete`, and
    `NotFoundError` on a missing row.
  - `onboardingProgressRls.test.ts` — School A scoped reads can't
    see School B's row; cross-tenant `markStepStatus` from A
    targeting B fails (the row appears not to exist) and B's data is
    unchanged via the admin connection; unscoped reads return null.
  - `onboardingRedirect.test.ts` — three cases: solo user with
    completed onboarding redirects to `/s/<slug>`, solo user
    mid-wizard redirects to `/s/<slug>/onboarding/<step>`, multi-
    membership user with a `swp_last_school` cookie pointing at an
    incomplete school redirects into that school's wizard.

## Decisions worth flagging

### JSON column for `step_statuses`, not per-step columns

Chosen on the spec's recommendation. Sprint 5–9 will each turn on a
new step; per-step columns would mean an enum migration plus a
column add every chunk. JSON keeps the schema flat at the cost of a
permissive parser in the repository — that's a deal we're happy to
take while only the repository writes the column.

### Step ordering source is TypeScript, not the DB enum

`onboarding_step` in Postgres is an enum; Postgres sorts enum values
by definition order, but we don't rely on that. Wizard ordering is
editorial (changes between chunks) and lives in
`ONBOARDING_STEP_ORDER` / `WIZARD_STEPS` in
`src/domain/onboarding.ts`. The DB only enforces that values are
inside the set.

### Missing `onboarding_progress` row is loud in the wizard, quiet on `/`

The AFTER INSERT trigger means a missing row is a real bug (trigger
didn't fire, manual DELETE, etc.) — auto-creating would cost us a
Sprint 5 debugging session because it would silently paper over the
problem. The wizard layout therefore throws if `getBySchool` returns
null.

The `/` landing page treats it as "no row, no redirect target" and
falls through to the dashboard. A user who has been using SwimPilot
for months should not get an error page on the first page after
sign-in just because their row was eaten — the dashboard's own
queries will surface the trigger bug eventually, and the redirect
isn't the right place to take down the homepage.

### Skills → Classes short-circuit (REVERSE THIS IN CHUNK 6)

Chunk 6 is the chunk that ships the `classes` stub at
`/s/<slug>/onboarding/classes`. Until then, advancing past Skills
would set `current_step = 'classes'` and the next render would 404.
`markStepComplete` short-circuits: when `nextStepAfter(step) ===
OnboardingStep.Classes`, it calls `complete()` instead — sets
`completed_at = now()`, parks `current_step` on `done`. The user
bounces to the dashboard.

The action returns `{ ...row, completedWizard: true }` for this
case so the placeholder pages can pick the right redirect target.
**Chunk 6 must remove this short-circuit** once
`/s/<slug>/onboarding/classes` exists. The condition is the only
thing to revert; the rest of the action is the shape Chunks 2–5
will keep.

### `(dashboard)` route group reorganisation

Next.js child layouts always nest inside parent layouts — there is
no "this layout overrides the parent" mechanism. The wizard chrome
at `s/[schoolSlug]/onboarding/` would otherwise wrap itself inside
the existing dashboard chrome at `s/[schoolSlug]/`, which is wrong
(the wizard owns the whole viewport during onboarding).

The fix was a route group: existing files moved from
`s/[schoolSlug]/{layout,page}.tsx` into
`s/[schoolSlug]/(dashboard)/{layout,page}.tsx`, with `_actions/`
and `_components/` going with them. The route group is invisible in
URLs (so `/s/riverside` still resolves to the dashboard `page.tsx`)
but breaks the layout chain — `(dashboard)/layout.tsx` and
`onboarding/layout.tsx` are siblings sharing only the `[schoolSlug]`
segment.

Files were moved verbatim — contents unchanged. The spec asked for
those files to be left alone; the path move is the minimum
disruption that satisfies both the spec's contract and Next.js's
layout-nesting reality.

### Generic `markStepComplete` action vs per-step actions

For Chunk 1, where every step's body is a placeholder, one generic
action is the right shape. Once Chunks 2–5 land real form bodies
with typed inputs (school profile fields, location list, level
catalogue, skill rubric), the natural fit is a per-step action
carrying its typed input — `markProfileComplete(input)`,
`markLocationsComplete(input)`, etc. The current shape keeps the
"mark step + advance pointer" mechanic identifiable; future chunks
should split when the input grows non-trivial validation.

### Help-link URL is a placeholder

`HELP_URL` in `s/[schoolSlug]/onboarding/layout.tsx` points at
`https://studioparallel.com.au/contact`. There's no "book a
migration call" page yet. Flagged in a `TODO(Chunk 6+)` comment in
the layout.

## What Chunks 2–5 plug into

- Each chunk replaces the body of one placeholder page with a real
  form. The `<form action={…}>` shape and the wizard layout stay.
- If a chunk needs the action to validate typed input, switch from
  the generic `markStepComplete` to a per-step action — copy the
  short-circuit-aware return shape (`{ ...row, completedWizard }`)
  so the placeholder-page redirect handler doesn't need rewriting.
- New steps becoming wizard-visible: extend `WIZARD_STEPS` in
  `src/domain/onboarding.ts`. The progress indicator and the zod
  enum in `markStepComplete` both pick it up automatically.

## What Chunk 6 specifically owes

- Add `s/[schoolSlug]/onboarding/classes/page.tsx` (the chunk's own
  step) and any others for Sprint 5.
- **Reverse the Skills → Classes short-circuit** in
  `_actions/markStepComplete.ts`. Once `classes` is a real route,
  `nextStepAfter(skills) === Classes` should redirect there, not
  call `complete()`.
- Replace `HELP_URL` with the real "book a migration call" URL once
  Studio Parallel publishes one.

## What's deliberately deferred

- No "skipped" UI flow this chunk. The status enum carries
  `skipped`, the progress indicator already treats skipped steps as
  reachable, and the JSONB column accepts the value, but no chunk-1
  page sets it. Chunks 2–5 add per-step skip affordances if they
  need them.
- No abandoned-onboarding reporting. `last_activity_at` exists for
  it but nothing reads the column yet.
- No revisit / edit affordance on the dashboard. Once
  `completed_at` is set the user lands on `/s/<slug>` as today;
  re-entering the wizard from a complete state is a Sprint 9+
  decision.
- No school-creation flow. Schools come from `prisma/seed.ts`. The
  trigger is built to handle a future admin-tool insert path
  identically.

## Verification

- `npx prisma generate` succeeded after the schema changes; the
  migration was applied to the test database via
  `npm run test:db:migrate`.
- `npx tsc --noEmit` is clean (after a `rm -rf .next/types` to
  drop the stale generated module references that pointed at the
  pre-move dashboard paths — they regenerate on the next dev /
  build run).
- All 15 chunk-1 tests pass against a real Postgres (Docker compose
  test stack). The full suite at the time of writing was 51 of 52
  test files passing — the one failure was
  `tests/integration/tenantRouting.test.ts > user with two
  memberships sees the picker with both schools` with `Error:
  'cookies' was called outside a request scope`. Pre-existing and
  unrelated to this chunk: verified by stashing chunk-1 changes and
  re-running, the failure persisted on `main`. The new
  `onboardingRedirect.test.ts` mocks `next/headers` correctly and
  passes; the equivalent fix in `tenantRouting.test.ts` is a
  separate spawned task.
- `npm run lint` reports one error in `prisma/seed.ts` (an existing
  `@prisma/client` import that the no-restricted-imports rule
  flags); pre-existing on `main`, not from this chunk.
