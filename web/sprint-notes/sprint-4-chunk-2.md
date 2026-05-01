# Sprint 4 / Chunk 2 — handoff

The Profile step body of the post-signup onboarding wizard, plus the
Supabase Storage seam every later asset-upload chunk will reuse.

## What landed

- Migration `20260501140000_add_school_profile_fields`:
  - Eight nullable columns on `schools`: `legal_name`, `trading_name`,
    `abn`, `gst_registered`, `primary_contact_name`,
    `primary_contact_email`, `primary_contact_phone`, `logo_url`.
    All nullable because Skip is a first-class outcome of this step
    and an existing school must remain valid after the migration.
  - No CHECK constraint on `abn` — validation is app-side only (see
    "Decisions" below).
  - The `logo_url` column is named for compatibility but stores a
    Supabase Storage **path** (`<school_id>/logo/<uuid>.png`), never
    a URL. Documented in `schoolRepository.ts` and the architecture
    doc.

- `src/repositories/schoolRepository.ts`:
  - `School` domain type extended with all seven profile fields
    plus `logoUrl`. All `nullable`.
  - `UpdateSchoolInput` widened to accept the same fields with
    `field: T | null` so the action can null-out a value
    explicitly (skip-after-save behaviour).
  - `toSchool()` mapper carries the new columns through.

- `src/lib/storage/client.ts` — the only place
  `@supabase/supabase-js` is imported. Lazy-built service-role
  client. `getStorageClient()`, `__setStorageClientForTesting()`
  (test seam, prod-unreachable),
  `SCHOOL_ASSETS_BUCKET = "school-assets"`,
  `StorageNotConfiguredError`. Production fails loudly if env is
  missing; dev / test surface a useful error message instead.

- `src/repositories/assetRepository.ts` — the only consumer of the
  storage client. Surface:
  - `uploadSchoolAsset(_db, { schoolId, assetType, file, contentType })
    → string` (returns the storage path)
  - `signSchoolAssetUrl(path, ttlSeconds = 3600) → string`
  - `deleteSchoolAsset(path) → void` (idempotent on not-found)
  - Filename is always a fresh `randomUUID()`. Extension is mapped
    from content type via a small allow-list. The path layout
    `<school_id>/<assetType>/<uuid>.<ext>` is constructed
    server-side; the API takes no caller-supplied path or filename.
  - Asset types are typed (`"logo" | "skill-photo" | "invoice"`) so
    Sprint 7 / 8 reuse without re-thinking the directory shape.

- `src/lib/auth/tenantAction`-wrapped server actions under
  `src/app/s/[schoolSlug]/onboarding/profile/_actions/`:
  - `uploadSchoolLogo(formData)` — content-type allow-list
    (PNG / JPEG / WEBP) and 2 MB ceiling, both validated at the
    action boundary so Storage never sees a rejected file.
  - `markProfileComplete(input)` — Zod discriminated union
    (`{ skip: true }` or `{ skip: false, ...profileFields }`). On
    save, normalises whitespace out of the ABN and validates
    11 digits; validates email if present. On skip, persists
    nothing. Either way, advances `current_step` to Locations and
    flips the step status to Completed (save) or Skipped (skip).
  - `saveProfileForm(schoolSlug, prev, formData)` — the
    `useActionState` bridge. Reads the `intent` button (`skip` /
    `save`), calls `markProfileComplete`, maps validation messages
    to inline `fieldErrors`, redirects to the next wizard step on
    success.

- `src/app/s/[schoolSlug]/onboarding/profile/`:
  - `page.tsx` — server component. Reads the school via
    `schoolRepository.getById` inside `withTenant`, signs an
    existing logo path via
    `assetRepository.signSchoolAssetUrl` for first-paint preview,
    swallows sign failures (the user can re-upload).
  - `_components/ProfileForm.tsx` — client component using
    `useActionState`. Logo upload is a direct
    `uploadSchoolLogo(formData)` call on file pick (separate from
    the form submit — see "Decisions"). Hidden `logoUrl` field
    carries the path through validation re-renders. Two submit
    buttons (`intent=skip` / `intent=save`) share the form.
    Inline `fieldError(name)` renderer for per-field validation
    messages. Currency renders disabled with an "MVP" caption.

- `prisma/seed.ts` — `SEED_SCHOOLS` carries plausible values for
  Riverside (ABN 51824753556) and Coastal (29004085616), both
  GST-registered, with primary contacts. Logo is **not** seeded
  (Storage is environment-dependent). The `INSERT … ON CONFLICT
  (slug) DO UPDATE` extends to write and refresh all seven
  profile fields so a re-seed lands the latest values.

- `web/.env.example` — added `NEXT_PUBLIC_SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` block before the Anthropic block,
  with comments explaining service-role and the bucket name.

- `web/eslint.config.mjs`:
  - Added two `no-restricted-imports` patterns:
    `@supabase/supabase-js` (constructible only from
    `src/lib/storage/**`) and `**/lib/storage/client` (consumable
    only from `src/lib/storage/**`, `src/repositories/**`, and
    `tests/**`).
  - Added `prisma/**` to the existing exemption block. The seed
    legitimately imports `@prisma/client` (it's not user-facing
    code) and was already failing the rule on `main` — calling it
    out here so it doesn't re-emerge.

- `web/docs/architecture.md` — new "File storage" section after
  "Server actions and `tenantAction`". Covers: why Supabase
  Storage; bucket layout (`school-assets/<school_id>/<assetType>/...`);
  private-bucket / signed-URL model and the three reasons for it;
  service-role-client rationale (and why Storage RLS would be
  redundant given `tenantAction`); the
  `assetRepository` surface; the upload-then-persist split; a
  worked logo round-trip; what's deliberately not done at MVP.

- 19 integration tests across four files:
  - `tests/integration/schoolProfileUpdate.test.ts` (4) — round-
    trip update via `schoolRepository.update`, null-out clears the
    columns, RLS rejects cross-tenant update, soft-delete is
    preserved across a profile update.
  - `tests/integration/markProfileComplete.test.ts` (7) — happy
    path saves and flips status to Completed; ABN whitespace is
    stripped before persisting; skip leaves columns null and
    flips to Skipped; ABN of 10 digits rejected with VALIDATION;
    ABN of 12 digits rejected; invalid email rejected; cross-
    tenant 404s before any write happens.
  - `tests/integration/uploadSchoolLogo.test.ts` (6) — happy path
    returns `<school_id>/logo/<uuid>.png`; SVG content-type
    rejected; 2 MB+ rejected; empty file rejected; missing file
    field rejected; cross-tenant 404s before Storage is touched.
    Storage is mocked at the boundary via
    `__setStorageClientForTesting`.
  - `tests/integration/seedSchoolProfileIdempotency.test.ts` (2)
    — running the schools-profile upsert twice with identical
    inputs leaves the same values and produces no duplicate rows
    (the part of the seed Chunk 2 changed).

## Decisions worth flagging

### `logo_url` column name

Kept the column name even though it stores a path. Renaming
mid-sprint costs us a follow-up migration and an audit of every
caller, for a marginal correctness win that's already documented
in two places. The domain type is honest (`logoUrl: string | null`,
with a comment), and the architecture doc spells out the storage
mechanic. If a future sprint touches the column for a different
reason it can rename then; we won't do it on its own.

### ABN validation is length-only

11-digit regex after whitespace stripping. The full AU ABN
checksum (modulus-89 weighted digits) is real and small but the
spec called it polish — an invalid ABN is a self-correction
issue, not a security one, and adding the algorithm later is one
line in the schema with no migration impact. If a tenant blocks
on this we can promote it; until then it stays out.

### GST defaults to "No" via radio, not via column default

The DB column is nullable; the form starts with the "No" radio
selected via JSX `defaultChecked`. This treats GST registration as
explicitly answered rather than implicitly true (which would be
the wrong default — most starting tenants haven't registered) or
explicitly null (which forces a third UI state we don't need).
On Skip the column stays NULL, preserving "user hasn't told us
yet"; on Save the column becomes a real boolean.

### Service-role client + service-role bucket, no Storage RLS

The Storage client is service-role and bypasses Supabase Storage
RLS. We don't enable Storage RLS at all. Tenancy is enforced one
layer up, in the same place every other write is enforced —
`tenantAction` resolves the slug to a `schoolId`, and the
`<school_id>/...` path is constructed from the resolved id, never
from caller input. Storage RLS would be redundant (and would
require minting per-request user JWTs against Supabase, which we
don't otherwise need). Documented in `docs/architecture.md`.

### Upload and form-save are separate actions

`useActionState` cycles re-render the form with the action's
returned state. Binary file inputs do not survive that cycle.
Splitting upload from save lets the validatable text fields use
`useActionState` cleanly while file picks fire their own
out-of-band action. The form holds the resulting path in client
state and a hidden field; the form-save action posts the path to
`markProfileComplete`. Side effect: a user who uploads then
abandons leaves an orphan in Storage but no orphan column. A
periodic cleanup of unreferenced `<school_id>/logo/*` is a future
cron, not a correctness problem this chunk owns.

### Skipped → Completed when a previously-skipped step is saved

If the user skips Profile, then later re-enters the step from the
progress indicator and saves real data, the status flips to
Completed. The user has explicitly committed values; preserving
"skipped" would misrepresent state. The reverse (Completed →
Skipped) does not happen — Skip on a previously-Completed step
is currently a no-op as far as `markProfileComplete`'s skip
branch persists nothing, but the status flip is unconditional in
the action. If a chunk later wants Skip-to-clear behaviour, that
becomes an explicit "Reset" affordance.

### Field-error mapping in `saveProfileForm` is heuristic

`tenantAction`'s result shape returns one validation message, not
field paths. `saveProfileForm` substring-matches on the message
("abn" → `abn` field, "email" → `primaryContactEmail`, else
`_form`) to render an inline error next to the right input. The
two messages this chunk's action raises are the only ones the
heuristic has to handle; if Chunk 3+ adds a per-step action with
more validation paths and they grow brittle, switch to a typed
`{ field, message }` payload from the action. Out of scope today.

### Logo previews use object URLs locally, signed URLs after save

On a fresh upload the client sets the preview to
`URL.createObjectURL(file)` and revokes the previous one. On the
next page render the server signs the stored path and the
preview is back, this time from durable storage. Only one signed
URL hits the wire per render, with a 1-hour TTL — long enough to
survive a slow render or a user revisiting the wizard, short
enough that a leaked URL stops working before it can do real
damage.

### Storage env in dev

`NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are not
required for any other flow this sprint. `getStorageClient()`
fails loudly with a typed `StorageNotConfiguredError` if the env
is missing — but only when something tries to call it, so the
rest of the dev experience is unaffected. The integration tests
mock the client at the boundary via `__setStorageClientForTesting`
and never touch real Supabase. **Production env is a separate
deploy-time task and is not landed in this chunk.**

## What Chunks 3–5 plug into

- The `_actions/save<Step>Form.ts` + `mark<Step>Complete.ts` +
  `_components/<Step>Form.tsx` triple is the shape every later
  chunk should copy. Bound action with `useActionState`,
  `intent=skip|save` buttons, redirect on success via
  `nextStepAfter`. The result shape
  (`{ ...progress, completedWizard }`) means the page-level
  redirect logic doesn't change between chunks.
- `assetRepository` is the seam for any later upload. Chunk 5
  (skill rubric) probably won't need it, but Sprint 7 (skill
  photos) and Sprint 8 (invoice PDFs) will. The asset-type union
  already lists `"skill-photo"` and `"invoice"`; just construct
  the path with the right `assetType` and the rest is identical.
- `getStorageClient()` is hot-path for any signed-URL render.
  Cache is module-scoped (one client per process). Don't
  introduce a per-request client.

## What's deliberately deferred

- **No orphan cleanup.** Out-of-form uploads accumulate in the
  bucket. A scheduled cleanup job is the right shape, not a
  per-request delete; would add it once a second asset type
  appears.
- **No CDN / image optimisation.** Logos serve straight from
  Supabase Storage. If logo loads become a hot path, proxy via
  Next's image route.
- **No per-school storage quota.** Lean on Supabase's project-
  wide ceiling and a dashboard alert.
- **No image cropping / transforms.** Logos are stored as-is.
- **No production Storage env.** `.env.example` documents the
  variables; the production deploy step is not in this chunk's
  scope.
- **No "Save and exit" behaviour.** The wizard layout already
  ships a Save-and-exit affordance from Chunk 1; this chunk did
  not need to change it. The Profile form's Save button calls
  `markProfileComplete` and redirects to the next step; an exit
  button would call the same action and redirect to
  `/s/<slug>`. Wiring that up is one line and was deferred to
  whichever chunk first needs the explicit affordance.

## Verification

- `npx prisma generate` succeeded after the schema change; the
  migration was applied to the test database via
  `npm run test:db:migrate`.
- `npx tsc --noEmit` is clean.
- `npm run lint` reports zero errors. (Three warnings remain:
  the `<img>` element in the form preview — flagged for a future
  `next/image` migration once we add image optimisation; and two
  unused-arg warnings in the upload test's mock storage client
  signature — kept named for documentation value.)
- All 19 chunk-2 integration tests pass against a real Postgres
  + a mocked Storage client (Docker compose test stack).
- Full suite: 55 of 56 test files passing. The one failure is
  `tests/integration/tenantRouting.test.ts > user with two
  memberships sees the picker with both schools` — `Error:
  'cookies' was called outside a request scope`. Pre-existing on
  `main`; verified by stashing chunk-2 changes and re-running.
  Same flag as the chunk-1 handoff.
