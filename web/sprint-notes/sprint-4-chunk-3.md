# Sprint 4 / Chunk 3 — handoff

The Locations step of the post-signup onboarding wizard. First chunk
to ship the list-of-N pattern (per-row mutations alongside a
step-advance) and the first to drop the substring heuristic in
favour of a typed `fieldErrors` payload from `tenantAction`.

## What landed

- Migration `20260501150000_add_location_address_fields`:
  - Five nullable columns on `locations`: `address_line`, `suburb`,
    `state`, `postcode`, `notes`. All nullable because Locations
    only requires a `name`; address detail is a polish field tenants
    fill in when they get to it.
  - No CHECK constraints. AU postcodes are the common case but not
    the only case (international tenants down the line), and the
    spec called this AU-first not AU-only.
  - The existing `timezone` column is left untouched. Per-location
    timezone overrides the school timezone when set; null falls
    back to school. The form surface treats null as the default
    (see "Decisions").
  - The existing `locations_school_id_idx` from the init migration
    is sufficient for the listing query; no new index added.

- `src/repositories/locationRepository.ts` (new file — Sprint 4
  spec was wrong about it pre-existing):
  - `Location` domain type with the seven persisted fields plus
    audit columns. All address fields nullable.
  - `getById(tx, id)` — filters soft-deleted via `deletedAt IS NULL`
    so a foreign or archived id returns `null`.
  - `listBySchool(tx, { includeArchived } = {})` — orders by
    `createdAt asc` so the rendered list is stable across re-reads.
    `includeArchived: true` is offered for the future restore UI;
    no caller uses it today.
  - `create(tx, input)` — pulls `schoolId` from `getSchoolId()`
    (AsyncLocalStorage), rejects orphan inserts via the audit
    extension's `actorId` guard.
  - `update(tx, id, patch)` — partial; the action layer guards
    cross-tenant by reading `getById` first.
  - `archive(tx, id)` — sets `deletedAt = now()`. No `unarchive`
    today.
  - Domain type added to `src/domain/types.ts` next to the existing
    `School` / `Membership` shapes.

- `src/lib/auth/tenantAction.ts` + `src/lib/errors.ts`:
  - `ValidationError` extended with optional
    `fieldErrors?: Record<string, string>`.
  - `ActionError` extended with the same field. The wrapper spreads
    it through only when present so existing actions that throw
    `new ValidationError("…")` see no change in their result shape.
  - `saveProfileForm.ts` updated to prefer the typed payload and
    fall back to the substring heuristic so existing behaviour is
    preserved.

- `src/lib/auth/tenantAction`-wrapped per-row server actions under
  `src/app/s/[schoolSlug]/onboarding/locations/_actions/`:
  - `locationFields.ts` — shared zod fields and `CreateLocationSchema`
    (name required ≤ 200; address fields nullable, sized).
    `UpdateLocationSchema = CreateLocationSchema.partial()`.
  - `addLocation(input)` — parses with `CreateLocationSchema`,
    builds a field-keyed error map from zod issues, throws
    `ValidationError(message, fieldErrors)`, calls
    `revalidatePath("/s/[schoolSlug]/onboarding/locations", "page")`
    on success so the server re-render picks up the new row.
  - `updateLocation({ id, patch })` — same shape; reads `getById`
    first and throws `NotFoundError` if the row is foreign or
    deleted, then applies the partial.
  - `archiveLocation({ id })` — silently idempotent. `getById`
    returns null for "already archived" or "foreign", and either
    way we return `{ archived: false }` without surfacing an error.
    Real archive returns `{ archived: true }`.
  - `markLocationsComplete()` — refuses with VALIDATION when zero
    non-archived locations exist (the gate that gives the step
    meaning); on pass, advances `current_step` to Levels and flips
    status to Completed via
    `onboardingProgressRepository.markStepStatus`. No skip path.
  - `saveLocationsForm(schoolSlug, prev, formData)` — the
    `useActionState` bridge. Delegates to `markLocationsComplete()`
    and redirects on success; surfaces the typed `fieldErrors` on
    failure.

- `src/app/s/[schoolSlug]/onboarding/locations/`:
  - `page.tsx` — server component. Loads `school` and `locations`
    in parallel inside `withTenant`, hands `schoolTimezone` and
    the location list to `LocationsList` as props.
  - `_components/LocationsList.tsx` — client component. Renders the
    list off `initial`; `useTransition` for per-row delete /
    archive UX; `useActionState` for the Continue button. Inline
    `LocationEditor` form (not a modal) for create and edit. Empty
    state opens the editor automatically. Timezone column hidden
    when null with a "Uses school timezone (X)" caption.

- `prisma/seed.ts` — `LocationSeed` extended with optional address
  fields. Plausible Sydney addresses on all four seeded locations
  (two for Riverside, two for Coastal). The
  `INSERT … ON CONFLICT (school_id, name) DO UPDATE` writes and
  refreshes all five new columns so a re-seed lands the latest
  values.

- 18 integration tests across five files:
  - `tests/integration/locationRepository.test.ts` (6) — round-
    trip with audit stamping; partial update; `listBySchool`
    filters soft-deleted by default and returns them with
    `includeArchived: true`; `archive` sets `deletedAt` and
    `getById` then returns null; RLS WITH CHECK rejects a direct
    create with a foreign `school_id`; cross-tenant `getById`
    returns null.
  - `tests/integration/addLocation.test.ts` (4) — happy path
    creates in current tenant; empty name → VALIDATION with
    `fieldErrors.name`; over-long name (201 chars) rejected;
    cross-tenant slug 404s before any write.
  - `tests/integration/updateLocation.test.ts` (2) — partial
    update mutates only the fields provided; cross-tenant slug
    targeting the other school's id returns NOT_FOUND without
    mutating.
  - `tests/integration/archiveLocation.test.ts` (2) — archive
    sets `deletedAt` and `listBySchool` excludes; double-archive
    is silently idempotent (second call returns
    `archived: false`).
  - `tests/integration/markLocationsComplete.test.ts` (4) — happy
    path advances to Levels and flips status to Completed;
    refuses with VALIDATION when zero non-archived locations
    exist; archived rows do not count toward the gate;
    cross-tenant 404s before any read.

## Decisions worth flagging

### `markLocationsComplete` has no skip path

Locations is a hard gate. The wizard's whole point downstream is
that classes hang off locations and teachers; without one location
you can't onboard a class. We treated Skip as the right call for
Profile (a tenant can run without a public legal name) but it
isn't here. The action raises a typed `_form` validation error
when zero rows exist; the form surfaces it next to the Continue
button.

### Per-row actions don't bridge through `useActionState`

`useActionState` cycles re-render the form with the action's
returned state. That's the right shape for a single submit (one
form, one action, one validation surface) but the wrong shape for
N independent rows. Each row mutation is a direct
`addLocation` / `updateLocation` / `archiveLocation` call wrapped
in `useTransition`; the action calls `revalidatePath` and the
server re-renders the list from the database. Continue (the
step-advance) goes through `useActionState` as before because it's
still a single action with a single validation surface. The two
patterns coexist in the same component cleanly.

### Inline editor, not a modal

The "Add another location" / "Edit" affordances open the editor
in-place above the list. Modals were the obvious alternative but
they cost a focus-trap, an Escape handler, and a backdrop, all
for marginal screen-real-estate savings on a step that has zero
other UI competing for attention. The inline form is cheaper to
ship and easier to test.

### Field-error payload promoted to a typed shape

`saveProfileForm.ts` was using a substring heuristic ("abn" in
the message → `abn` field) because `tenantAction`'s result shape
exposed only one error message. That worked for two fields and
was already on the chopping block. This chunk promotes
`ValidationError.fieldErrors` and `ActionError.fieldErrors`
through the wrapper. The Profile form keeps its heuristic as a
fallback so existing tests stay green; new actions use the typed
shape end-to-end. `addLocation` and `updateLocation` build the
map from `result.error.issues` (zod's path → message).

### `archiveLocation` is silently idempotent

A row that was already archived (or that belongs to another
tenant — RLS hides it from `getById`, returning null) returns
`{ archived: false }`, not an error. Two reasons: (a) the UI
doesn't distinguish "I just archived it" from "it was already
gone" — both end states are the same; (b) a stale list could
double-fire archive on the same id and we don't want the second
fire to surface as a noisy 404 to the tenant. Cross-tenant is
still defended; it just defends silently rather than loudly.
There is no separate restore action this chunk; if Sprint 5+
wants one, it lives next to `archive` in the repository.

### Per-location timezone is null by default

The form does not surface a timezone selector. Locations inherit
the school's timezone unless the column is set, and we don't
have a use case yet that forces a per-location override (one
school, one city, one tz). The column stays for the day a tenant
runs pools across tz boundaries; the list view shows
"Uses school timezone (X)" so the user knows what's in effect.
Wiring up an explicit selector is one input plus a zod field;
deferred until a tenant asks.

### `listBySchool` orders by `createdAt asc`

Stable insertion order. The list editor adds rows to the bottom,
which matches a tenant's mental model of "I added Parramatta
first, then Ryde". Alphabetical was the alternative and would
require a re-order on every name edit. If a UI later wants
alphabetical sort, that's a client-side concern, not a
repository concern.

### `locationRepository` was created fresh

The Sprint 4 spec described it as already existing. It didn't.
That cost no time — the repository pattern is the same shape we
use for `schoolRepository` / `membershipRepository` — but flagging
it here so a future sprint reading the original spec doesn't
re-invent the file thinking it's already there.

## What Chunks 4–5 plug into

- **The list-of-N pattern.** Levels (Chunk 4) and Skills
  (Chunk 5) are both lists. Copy the `_components/<Step>List.tsx`
  + per-row actions + `mark<Step>Complete.ts` + `save<Step>Form.ts`
  triple from this chunk. Per-row mutations call `revalidatePath`;
  Continue runs through `useActionState`.
- **Field-error mapping.** New per-step actions should populate
  `ValidationError.fieldErrors` from their zod schema and let the
  typed shape flow through `tenantAction`. Don't add new substring
  heuristics — Profile keeps its only because rewriting that
  form was out of scope.
- **Soft-delete + idempotent archive.** Levels and Skills will
  want the same shape: `deletedAt`-filtered `listBySchool`,
  silently idempotent archive. The repository surface here
  (`getById` filtering deleted, `archive` setting `deletedAt`,
  `listBySchool({ includeArchived })`) is the template.
- **Hard-gate step advance.** Levels needs at least one level
  before a class can hang off it; Skills the same shape.
  Reuse `markLocationsComplete`'s pattern — count non-archived
  rows in the repository, throw `ValidationError` with a `_form`
  message, no skip path.

## What's deliberately deferred

- **No address validation / geocoding.** AU postcodes have a
  valid range but we don't enforce it; suburb / state / postcode
  are all free-text. International tenants would break a strict
  AU validator; address verification is an external-API concern,
  not an MVP one.
- **No map preview.** A pin on a Mapbox / Google embed would be
  pleasant; not a functional gap.
- **No reorder UI.** Locations are stored and listed in
  insertion order. Drag-to-reorder is a polish task and adds a
  `displayOrder` column.
- **No restore / unarchive UI.** The repository can list
  archived rows (`includeArchived: true`); no surface uses it.
  When Sprint 5+ adds a "deleted items" affordance it lives
  here.
- **No per-location billing or capacity.** Both belong to
  Sprint 6 / 7; the column shape stays minimal until then.

## Verification

- `npx prisma generate` succeeded after the schema change; the
  migration was applied to the test database via
  `npm run test:db:migrate`.
- `npx tsc --noEmit` is clean.
- `npm run lint` reports zero errors. (Five warnings remain,
  none new from this chunk except two `_prev` / `_formData`
  unused-arg warnings on `saveLocationsForm.ts` — kept named
  for documentation value, matching the same pattern in the
  upload test mock signature called out in Chunk 2.)
- All 18 chunk-3 integration tests pass against a real Postgres
  (Docker compose test stack).
- Full suite: 59 of 61 test files passing (255 of 257 tests).
  Two failures, both pre-existing on `main`:
  - `tests/integration/tenantRouting.test.ts > user with two
    memberships sees the picker with both schools` — `Error:
    'cookies' was called outside a request scope`. Same flag
    carried forward from Chunks 1 and 2.
  - `tests/integration/clerkWebhook.test.ts > user.updated
    changes email and name on the existing row` — 30 s test
    timeout, intermittent. Not a regression from this chunk;
    flagged here so a future Clerk-area chunk knows to look.
