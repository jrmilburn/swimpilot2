# Architecture: data access

## Repository pattern

All database access goes through a **repository layer**. Domain code (server actions, services, route handlers, components) calls repositories — never Prisma directly.

This is enforced by an ESLint rule (`no-restricted-imports`, `error` level) banning imports of:

- `@prisma/client` and its subpaths
- the wrapped client at `src/lib/db/client`

The ban is lifted only for files under:

- `src/lib/db/**` — the **construction** site (the extended Prisma client, the audit extension, tenant context, `withTenant`)
- `src/repositories/**` — the **consumption** site (every repository file)

### Why ban direct Prisma imports outside repositories

- **Testability.** A repository function takes a `DbClient` argument; tests can pass a fake or a real test transaction without monkey-patching modules.
- **Swap-ability.** If we ever change ORMs, replace Prisma with raw SQL for hot paths, or add a read replica, the blast radius is the repository layer.
- **Single place for cross-cutting concerns.** Logging, metrics, caching, soft-delete filtering, and tenant-context wiring all belong in one well-known layer instead of scattered call sites.
- **Prevents tenant-context bypass.** Calling `prisma.school.findMany()` from a server action would run *outside* `withTenant`, with no `app.school_id` GUC set, and RLS would return zero rows — a confusing failure mode at best, a leak at worst if RLS were ever misconfigured. Forcing all access through repositories keeps callers honest about transactions.

## Layering

```
server action / service          ← domain logic, calls repositories
        │
        ▼
   repositories                  ← only place that touches Prisma models
        │
        ▼
 lib/db (client + extensions)    ← constructs Prisma, audit extension, withTenant
        │
        ▼
       Prisma                    ← generated client
```

- **Server actions / services** open a tenant context with `getTenantContext` (or `withTenant` for system jobs), receive a `tx`, and pass it to repositories.
- **Repositories** are stateless functions that take a `DbClient` (a transaction or the base client) and return domain types.
- **`lib/db`** sets up the audit-fields extension (stamps `createdBy` / `updatedBy` from `AsyncLocalStorage`) and the `withTenant` helper (sets `app.school_id` / `app.user_id` GUCs as `set_config(_, _, true)` so RLS policies can match them).

The audit extension runs *underneath* repositories — repositories don't know about it. They pass `data` without `createdBy` / `updatedBy`; the extension fills them in before the query reaches the database.

## How to add a new repository

1. **File.** Create `src/repositories/<aggregate>Repository.ts`. One file per aggregate root (School, Membership, Location, …). Don't bundle multiple aggregates.

2. **Types.** Define the domain type, the create input, and the update input *in the repository file*. Do not re-export Prisma's generated types — define your own and map at the boundary:

   ```ts
   export type Foo = { id: string; /* … */ };
   export type CreateFooInput = { /* required fields, no audit, no id */ };
   export type UpdateFooInput = Partial<{ /* mutable fields only */ }>;
   ```

   `CreateFooInput` excludes `id` and audit fields (`createdBy`, `updatedBy`, `createdAt`, `updatedAt`, `deletedAt`). `UpdateFooInput` is a partial of mutable fields only.

3. **Client argument.** Each function takes a `DbClient` as its first parameter:

   ```ts
   import { prisma } from "../lib/db/client";
   import type { TenantTx } from "../lib/db/withTenant";

   export type DbClient = TenantTx | typeof prisma;

   export async function getById(db: DbClient, id: string): Promise<Foo | null> { … }
   ```

   This is the **explicit-arg** pattern. We chose it over pulling the transaction client from `AsyncLocalStorage` because:
   - `AsyncLocalStorage` only carries `actorId` / `schoolId` today (used by the audit extension); adding `tx` would mean two sources of truth for the active transaction.
   - Explicit arguments make the call sites' transactional intent obvious and let tests inject a fake client without touching async context.

4. **Transactional usage.** The intended call shape:

   ```ts
   await getTenantContext(async (tx) => {
     const school = await schoolRepository.getById(tx, id);
     // …
   });
   ```

   Inside `getTenantContext` / `withTenant`, the `tx` already has `app.school_id` set, so RLS scopes every query. Repositories don't set GUCs themselves — that's `withTenant`'s job.

5. **Calling without a tenant context.** You may pass the base `prisma` client for system-level work (migrations, seeds, cross-tenant admin). For tenant-scoped models, this returns nothing useful: RLS policies see no `app.school_id` and reject the rows. That is the correct behaviour — failing closed prevents accidental cross-tenant reads.

6. **Mapping.** Always map Prisma rows to your domain type before returning. Even if the shapes are identical today, the mapper is the seam where they can diverge later.

7. **No leaking Prisma types.** Function signatures must not mention `Prisma.FooWhereInput`, `Prisma.FooCreateInput`, etc. If you need richer query options, add named parameters (`{ includeDeleted?: boolean }`) and translate inside the repository.

## Worked example: `schoolRepository`

`src/repositories/schoolRepository.ts` exposes three functions:

```ts
getById(db: DbClient, id: string): Promise<School | null>
create(db: DbClient, input: CreateSchoolInput): Promise<School>
update(db: DbClient, id: string, input: UpdateSchoolInput): Promise<School>
```

Walk through `create`:

1. Caller is inside `getTenantContext`, so `tx` has `app.school_id` and `app.user_id` set, and `AsyncLocalStorage` holds the same `actorId`.
2. `create(tx, { name, timezone, currency })` is called. The input has no `createdBy`, `updatedBy`, or `id`.
3. Inside the repository, `tx.school.create({ data: input })` runs.
4. The **audit extension** (`src/lib/db/extensions.ts`) intercepts the `create` operation, reads `actorId` from `AsyncLocalStorage`, and stamps `createdBy` / `updatedBy` on `data`.
5. The query hits Postgres. RLS policies on `schools` check `app.school_id`; the row passes (or doesn't, if it's another tenant's row).
6. The returned row is mapped through `toSchool` and handed back as a `School` domain type — no Prisma types in the return signature.

`getById` and `update` follow the same pattern. Without a tenant context (no `app.school_id` set), RLS rejects the read and `getById` returns `null` / `update` throws `RecordNotFound`. That is the intended "fail closed" behaviour.

## Server actions and `tenantAction`

Every server action under `/s/[schoolSlug]/` **must** be wrapped in `tenantAction()` from `src/lib/auth/tenantAction.ts`. No exceptions without architectural review. Server actions that bypass it would either run unscoped (data leak) or duplicate the resolution logic (drift).

### The flow

```
form action  ─►  tenantAction wrapper
                    │
                    ├─► reads `x-school-slug` from request headers
                    │     (set by middleware.ts for /s/[slug]/* routes)
                    ├─► requireTenant(slug)  → { userId, schoolId, role }
                    ├─► withTenant(...)      → opens RLS-scoped tx
                    │     ├─► action body runs with TenantContext
                    │     │     └─► repository(tx, …)  → Prisma  → Postgres
                    │     └─► commit
                    └─► result mapping → ActionResult<T>
```

1. Middleware sees `/s/[slug]/...` and forwards a trusted `x-school-slug` header to the action's request scope. Slug-from-headers is not user-controlled — never trust a slug from the action body.
2. `tenantAction` reads the header, calls `requireTenant(slug)` (redirects unauthenticated callers; 404s missing/no-membership), then opens `withTenant`.
3. Inside the transaction, GUCs `app.school_id` / `app.user_id` are set so RLS policies match. The audit-fields extension reads the same actor from `AsyncLocalStorage` and stamps `created_by` / `updated_by`.
4. The wrapped function receives `{ userId, schoolId, role, tx }` and any args the caller passed. It calls repositories with `tx`.
5. Typed errors are mapped to result codes. Anything else is logged with full stack and surfaced as a generic 500-equivalent.

### Result-object convention

Actions return `ActionResult<T>`:

```ts
type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: 'NOT_FOUND' | 'FORBIDDEN' | 'VALIDATION' | 'INTERNAL'; message: string } };
```

Why a result instead of throwing?

- Plays cleanly with React's `useActionState` / `useFormState` on the client — no try/catch in every form.
- Forces the call site to acknowledge the failure path; throwing makes it easy to forget.
- Lets the wrapper map domain errors to a finite set of codes the UI can render uniformly.

Next.js's own control-flow errors (`redirect`, `notFound`, `forbidden`, `unauthorized`) are the exception: they MUST throw all the way out so the framework can handle them. The wrapper uses `unstable_rethrow` from `next/navigation` to re-throw those before the generic catch.

### Action signature convention

**Context-first, args after.** This is the canonical shape:

```ts
export const renameSchool = tenantAction(
  async ({ tx, schoolId }, input: { name: string }) => {
    return schoolRepository.update(tx, schoolId, { name: input.name });
  },
);
```

Rationale: the wrapper stays generic over typed arguments — it doesn't bake `FormData` into its signature, so the same wrapper works for actions called from typed client code. For form-driven actions, parse `FormData` at the call site (or with a Zod schema in the action body):

```tsx
async function rename(formData: FormData) {
  "use server";
  await renameSchool({ name: String(formData.get("name") ?? "") });
}
<form action={rename}>…</form>
```

### Error mapping

| Inside the action body                            | Returned to caller                                       |
| -------                                           | --------                                                 |
| `throw new NotFoundError(msg)`                    | `{ ok: false, error: { code: 'NOT_FOUND', message } }`   |
| `throw new ForbiddenError(msg)`                   | `{ ok: false, error: { code: 'FORBIDDEN', message } }`   |
| `throw new ValidationError(msg)`                  | `{ ok: false, error: { code: 'VALIDATION', message } }`  |
| Any other `throw`                                 | `{ ok: false, error: { code: 'INTERNAL', message: 'Something went wrong' } }` — original logged with stack, never sent to client |
| `redirect()` / `notFound()` / `forbidden()` etc.  | Re-thrown via `unstable_rethrow` — framework handles     |

### Reference example: `updateSchoolName`

`src/app/s/[schoolSlug]/_actions/updateSchoolName.ts`:

```ts
"use server";

import { z } from "zod";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import * as schoolRepository from "@/repositories/schoolRepository";

const Input = z.object({ name: z.string().min(1).max(120) });

export const updateSchoolName = tenantAction(
  async ({ tx, schoolId }, input: unknown) => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Invalid school name");
    }
    return schoolRepository.update(tx, schoolId, { name: parsed.data.name });
  },
);
```

Walkthrough for a request:

1. The dashboard at `/s/riverside` mounts a `<form>` whose `action` is a small server function that wraps `updateSchoolName`.
2. The form posts back to `/s/riverside`. Middleware matches the path and sets `x-school-slug: riverside`.
3. The form-action server function calls `updateSchoolName({ name: ... })`. `tenantAction` reads the header, runs `requireTenant("riverside")` → `{ userId, schoolId, role }`, opens `withTenant`.
4. Inside the tx (`app.school_id` set), the wrapped body validates the input, then calls `schoolRepository.update(tx, schoolId, { name })`. RLS confirms the row belongs to riverside; the audit extension stamps `updated_by`.
5. The wrapper returns `{ ok: true, data: <School> }`.

If the user posts to a slug they don't belong to, middleware still sets the header from the URL but `requireTenant` calls `notFound()` — the 404 propagates via `unstable_rethrow`, never returned as a `{ ok: false, … }` result.

### Where unscoped actions live

Anything that can't be tied to a single school — admin tooling, webhooks (e.g. Clerk user sync), system jobs, cross-tenant reporting — does NOT use `tenantAction`. Those run elsewhere (typically `/api/webhooks/...` or admin-only routes) and use the base `prisma` client (RLS-bypass roles) under tightly-scoped code paths. They are out of scope for this layer.

### Future hooks

`tenantAction` is the natural place to add later, without touching action call sites:

- structured logging (action name, slug, userId, duration, outcome code)
- per-action rate limiting
- request metrics / tracing spans
- role-based authorisation policies (the `role` is already in `TenantContext`)

## File storage

User-uploaded binary content — school logos, later attendance photos,
invoice PDFs, signed waivers — does not live in Postgres. It lives in
Supabase Storage, and the database stores only the storage **path**
(not the URL) for each asset. This section documents the seam: where
the SDK is allowed, what the bucket layout looks like, why the bucket
is private, and how a server action moves bytes from a browser into
storage.

### Why Supabase Storage

We already run Supabase for auth and Postgres. Adding a separate
object store (S3, R2, Cloudflare Images) would mean a second set of
credentials, a second IAM model, a second URL-signing implementation,
and a second story to tell on-call. Supabase Storage is S3-compatible
underneath, so we keep the option to swap it later for the cost of
re-implementing one repository file. For MVP that trade is correct.

### Bucket layout

One bucket — `school-assets` — for everything tenant-scoped. Paths
are namespaced by school id and asset type:

```
school-assets/
  <school_id>/logo/<uuid>.<ext>
  <school_id>/attendance-photo/<uuid>.<ext>
  <school_id>/invoice/<uuid>.pdf
  <school_id>/waiver/<uuid>.pdf
```

The school id prefix is load-bearing: it lets us reason about
tenant ownership purely from the path, and gives us an obvious
sharding key if we ever migrate to per-tenant buckets. The asset
type segment lets us list/clean per category without an index. The
filename is always a fresh UUID — never a user-supplied name —
because user-supplied filenames are an injection surface (path
traversal, header confusion) we don't need to fight.

### Private bucket, signed URLs

The bucket is private. There is no public read. Every render that
needs to display an asset asks `assetRepository.signSchoolAssetUrl`
for a short-lived (default 1-hour) signed URL.

Why private:

1. **Cross-tenant isolation by default.** A misrouted path or a
   leaked id cannot be opened by an outside browser without a
   signature.
2. **Revocability.** If a tenant churns or an asset must be pulled,
   we don't have to chase down cached public URLs.
3. **Audit story.** Every read is implicitly a server-side decision
   — we can add per-asset auth later (e.g. only family members see
   their own attendance photos) without changing the public-vs-
   private posture.

Signed URLs are issued at server-render time (Server Components or
server actions) and embedded in the HTML. They're not minted in
client components.

### Service-role client only

`@supabase/supabase-js` lives in exactly one module:
`src/lib/storage/client.ts`. ESLint forbids importing it
anywhere else.

The Storage client is the **service-role** client. It bypasses
Storage RLS, because tenancy is enforced one layer up by the same
mechanism every other write goes through: the action runs inside
`tenantAction`, which has already pinned the school id. The
storage path is constructed from that pinned id — the request
body cannot influence which `<school_id>/` prefix the file lands
under. RLS on the storage bucket would be redundant (and would
require us to mint per-request user JWTs against Supabase, which
we don't otherwise need).

In other words: the storage path is derived, not supplied. The
service-role client is safe **because** it is only reachable from
inside `tenantAction`-scoped code.

### `assetRepository`

`src/repositories/assetRepository.ts` is the only module that
calls the storage client. The surface is intentionally small:

```ts
uploadSchoolAsset(_db, { schoolId, assetType, file, contentType })
  → string                    // returns the storage path
signSchoolAssetUrl(path, ttlSeconds = 3600)
  → string                    // returns a signed URL
deleteSchoolAsset(path)
  → void                      // idempotent on not-found
```

The repository:

- generates the UUID filename and resolves the extension from the
  content type (we don't trust user-supplied filenames),
- enforces the `<school_id>/<assetType>/...` shape,
- raises a typed error on storage failures so the action layer can
  return a clean `ActionResult`.

Note the `_db` argument: it's unused today (storage isn't
transactional with Postgres), but it keeps the call shape uniform
with every other repository function so callers don't need to
remember which repos take a `tx` and which don't.

### Upload-then-persist split

Uploading a file and saving the form that references it are
**separate** server actions. The form's `<input type="file">`
fires a direct `uploadSchoolLogo(formData)` call as soon as the
user picks a file. That action returns a path. The form holds the
path in client state (and a hidden `<input>`); the eventual
"Save and continue" submit posts the path through
`markProfileComplete`, which is what writes the column.

This split exists because:

1. **`useActionState` doesn't multipart.** React's
   `useActionState` cycles re-render the form with the action's
   returned state — but binary file inputs don't survive
   serialisation through the state cycle. Splitting the upload
   keeps `useActionState` for the validatable text fields where
   it shines.
2. **Server-side storage is the source of truth.** If the user
   uploads, then closes the tab, we have an orphan in the bucket
   — but no orphan column reference. A periodic cleanup of
   unreferenced `<school_id>/logo/*.png` is a future cron, not a
   correctness problem.
3. **Failure isolation.** A network error on upload leaves the
   rest of the form intact. The user can re-pick a file and
   retry without losing what they typed.

### Worked example: school logo

1. User opens `/s/<slug>/onboarding/profile`. The page server-
   reads the school via `schoolRepository.getById`. If
   `school.logoUrl` is set (it stores a path), the page calls
   `assetRepository.signSchoolAssetUrl(path)` and passes the
   signed URL to the client form for first-paint preview.
2. User picks a new file. The client component calls
   `uploadSchoolLogo(formData)`. That action validates content
   type and size, then `assetRepository.uploadSchoolAsset` writes
   `<school_id>/logo/<uuid>.png` and returns the path.
3. The client stores the new path in state (and a hidden form
   field), and shows a local object URL as the preview until the
   next page render.
4. User clicks "Save and continue". The form posts the hidden
   `logoUrl` (path) to `markProfileComplete`, which calls
   `schoolRepository.update` with `{ logoUrl: path, ... }`. The
   `schools.logo_url` column now holds the path.
5. On the next render, the page signs the stored path again and
   the preview is back, this time from durable storage.

Things deliberately not done at MVP:

- No CDN cache headers / image optimisation. We serve straight
  from Supabase Storage. If logo loads become a hot path we'll
  proxy via Next's image route.
- No orphan cleanup. Out-of-form uploads accumulate; we'll add a
  scheduled job once we have multiple asset types.
- No quota per-school. We lean on Supabase's project-wide
  ceiling for now and surface a dashboard alert.
- No client-side pre-hash for resumable uploads. Files are small
  (≤2MB for logos).

## Onboarding

Sprint 4 ships the post-signup onboarding wizard. A new school's owner
walks through Profile → Locations → Levels → Skills → (Sprint 5+)
Classes, with each step persisted server-side so the owner can resume
on any device. Sprint 5 onwards adds Classes / Teachers / Billing /
Channels / Import.

### State model

One row per school in `onboarding_progress` (PK is `school_id`). The
table is RLS-scoped on `app.school_id` like every other tenant table,
and an AFTER INSERT trigger on `schools` materialises the row at
school-creation time so the application code never has to auto-create.

The `step_statuses` column is `JSONB`, keyed by step name with values
from the `onboarding_step_status` enum (`not_started | in_progress |
completed | skipped`). Why JSONB rather than a column-per-step:
Sprints 5–9 each turn on a new step, and per-step columns would mean
an enum migration plus a column add every sprint chunk. The JSONB
shape is forward-compatible at the cost of a permissive parser in the
repository (`onboardingProgressRepository.parseStepStatuses` drops
unknown keys, falls back to `not_started` for unknown values).

`current_step` is an `onboarding_step` enum that already carries every
Sprint 4–9 step (`profile | locations | levels | skills | classes |
teachers | billing | channels | import | done`). The enum is loaded up
front so subsequent sprints don't churn the DB enum every chunk;
wizard *ordering* is editorial and lives in TypeScript
(`ONBOARDING_STEP_ORDER` in `src/domain/onboarding.ts`) — the DB only
enforces that values are inside the set.

The trigger and the cross-tenant lookup function both live in
`prisma/migrations/20260501130000_add_onboarding_progress` —
`app_create_onboarding_progress()` (AFTER INSERT, SECURITY DEFINER,
`ON CONFLICT DO NOTHING` so the migration backfill is idempotent) and
`app_get_onboarding_state(school_id uuid)` (SECURITY DEFINER, the
seam used by the post-sign-in redirect because no tenant context
exists yet at `/`).

### Resume contract

Closing the browser mid-step and reopening lands the owner back on the
same step with the persisted state. **Persisted state only — not
unsaved form drafts.** A half-typed location with no Save click is
gone on refresh. Per-step actions (`markProfileComplete`,
`markLocationsComplete`, `markLevelsComplete`, `markSkillsComplete`)
write on Save / Skip; nothing writes on navigate-away. Per-row
mutations inside list-of-N steps (`addLocation`, `updateSkill`, …)
write immediately and rely on `revalidatePath` to refresh the page.

### Redirect rule

After Clerk sign-in, `/` (`src/app/page.tsx`) calls
`tenantRepository.getOnboardingRedirectState(schoolId)`, which is a
`$queryRaw` against `app_get_onboarding_state(uuid)` on the base
prisma client (no tenant context open yet — same shape as
`lookupTenant`). The decision tree:

- `completed_at IS NOT NULL` → redirect to `/s/<slug>` (the
  dashboard).
- `completed_at IS NULL` → redirect to
  `/s/<slug>/onboarding/<currentStep>`.
- No row → fall through to the dashboard. A missing row is loud in
  the wizard layout (it throws — the trigger should have created the
  row) but quiet on `/` (a months-old user who somehow has their row
  deleted shouldn't get an error page on every sign-in).

### Why server, not localStorage

A school owner signs in on a phone, completes Profile, then opens
their laptop. localStorage on the phone wouldn't tell the laptop they
finished Profile — the laptop would re-prompt for the same fields.
Server is the only honest source of truth across devices, and once
the data is on the server anyway the cost of also persisting the step
status is a single column.

### Skip semantics

Steps that allow Skip set the status to `skipped`. The progress
indicator treats `skipped` as reachable (the operator chose to skip
and may want to come back). Re-entering a skipped step and saving
real data flips the status to `completed` — the step was completed,
the original skip was just a temporary deferral. Locations is the
only step that doesn't allow Skip (the wizard can't render the rest
without at least one location row to attach classes to).

### Classes step

Sprint 5 / Chunk 1 replaced the Sprint 4 placeholder with the real
Classes step. The page renders an accordion grouped by level — a
school's "Beginner" level expands to show its classes, plus a "Add
class" row that opens an inline editor for day, start time, duration,
location, and capacity.

Classes belong to a level *and* a location, so the page short-circuits
into a "Add a location first" or "Add a level first" hint when either
prerequisite is empty. Both back-links keep Skip available so the
operator can defer Classes entirely; the wizard's terminal step
(`markImportComplete`) is the only one that actually flips
`completed_at`.

The capacity invariant — `capacity ≤ level.ratio` — is enforced at two
layers, deliberately. The DB has a row-level `CHECK` triggered by a
function that joins to the level (see "Domain model — Class levels
and classes → `capacity ≤ level.ratio`"); the action layer in
`addClass` / `updateClass` does the same check before the insert so
the operator gets a clean validation error rather than a Postgres
constraint violation. Two layers, one truth: the trigger is the safety
rail, the action is the UX.

Teachers are the cross-step seam. A class can park on a pending
invitation via `pendingTeacherInvitationId` (XOR with `teacherId` —
see the Teachers sub-section). At Classes-step time the operator
hasn't been to Teachers yet, so the create form has no teacher
picker; teachers are bound on the Teachers step that follows.

Save path requires ≥ 1 class; Skip is always available. The
authoritative count check lives in `markClassesComplete` so a stale
page can't bypass the gate.

### Teachers step

Sprint 5 / Chunk 1. Three panes top-to-bottom: a roster (real teachers
plus pending invitations, with a Revoke per pending row), an invite
form (email-only — Clerk owns the rest of the identity dance), and an
assignment list (classes with neither a teacher nor a pending
invitation, with a per-row dropdown to bind one).

Inviting a teacher creates a Clerk Invitation and a corresponding
`pending_invitations` row. We hold both — Clerk is the auth seam, the
local row is the addressable surface for "park a class on this
person." The two are joined by `clerkInvitationId`. Revoke walks the
chain in reverse so a cancelled local row also cancels the upstream
Clerk invitation.

Acceptance is asymmetric. The teacher signs in via Clerk's invitation
flow and lands on a redirect handler that calls
`resolveAcceptedInvitation`. That action does three things atomically
inside one `withTenant` tx: (a) flip the pending row to `accepted`
with the new `acceptedUserId`, (b) materialise the membership
(`role='teacher'`), and (c) for every class parked on the invitation,
swap `pendingTeacherInvitationId = NULL, teacherId = <new>`. The
single SQL UPDATE per swap keeps the row's mutual-exclusion invariant
(at most one of `teacherId` / `pendingTeacherInvitationId` is non-null)
true throughout.

The XOR is enforced at the DB layer:

```sql
CHECK (
  (teacher_id IS NULL AND pending_teacher_invitation_id IS NULL)
  OR (teacher_id IS NOT NULL AND pending_teacher_invitation_id IS NULL)
  OR (teacher_id IS NULL AND pending_teacher_invitation_id IS NOT NULL)
)
```

No count gate either way — Teachers is fully optional. A school can
roster classes against the owner's own teacher record indefinitely.

### Import step

Sprint 5 / Chunk 2 (the importer) and Chunk 3 (AI suggestions) build
the final step. The page (`ImportWorkspace`) is a client component
that lifts `mapping` and `resolutions` state — `MappingPanel` is
externally controllable so the AI suggestions panel can write a new
mapping in by calling the same `setMapping` the manual pane uses.
The contract is enforced by `tests/unit/mappingPanelContract.test.ts`:
the panel cannot quietly re-internalise the state without breaking
the test.

The bridge (`saveImportForm`) handles six intents: `parse-csv`,
`dry-run`, `commit`, `rollback`, `save`, `skip`. Only the last two
redirect; the four interactive intents return updated form state for
`useActionState` to render. The AI suggestions panel calls
`suggestColumnMapping` directly via `useTransition` rather than
through the bridge — the bridge is for sequential page state, the AI
fetch is parallel and asynchronous to the operator's work.

Validation has four rule families, all in `processRow`:
`duplicate_email` (within-batch and against existing families),
`missing_required` (email / first / last; enrolment is all-or-
nothing; DOB parse errors surface here), `unknown_level`
(case-insensitive lookup with a Levenshtein ≤ 3 suggestion), and
`capacity_breach` (warning-level: existing + proposed + 1 > capacity,
proposed accumulates within the batch). The rule-by-rule resolution
buttons (Merge, Use suggested level, Skip enrolment, Exclude row)
update the local resolutions map; a fresh dry-run re-validates with
the resolutions applied.

Dry-run uses a Postgres `SAVEPOINT` inside the open `withTenant` tx,
runs the full insert pass, then `ROLLBACK TO SAVEPOINT` so the
operator sees realistic row IDs and capacity numbers without
committing. Both `dryRunImport` and `commitImport` call the same
`runImportPass(persistBatch: boolean)` driver — there is no second
implementation to drift. Commit re-validates inside its own savepoint
first; if blocking, the savepoint rolls back and the bridge surfaces
the report. Rollback walks `enrolments → students → families` in FK
order then stamps `rolledBackAt` on the batch row.

The AI layer added in Chunk 3 sits on top, not in the path. The
`csv-column-map` prompt module runs on Haiku; the action returns a
discriminated union `{ ok: true, mapping, confidence } | { ok: false,
reason: "low_confidence" | "ai_unavailable" | "invalid_response" }`.
Every failure mode degrades to the existing hand-mapping flow — the
form keeps working when AI is down, when the response doesn't parse,
when the model is uncertain across the board, or when the API key
is missing. The `ai_calls` row is written by `withAI` itself, with
`feature: "onboarding-csv-map"`. The hash uses `hashStableInput` so
the same headers + sample rows hash the same regardless of how the
caller constructed the input.

## Onboarding templates

The post-signup onboarding wizard (Sprint 4) lets a school operator
pre-fill several steps from a canonical template rather than building
everything from scratch. Templates live in TypeScript (under
`src/domain/`), not in the database — they are SwimPilot product
decisions that may evolve between releases independent of any tenant's
schema. Once applied, the rows are owned by the tenant and edits stay
local.

Two templates live under `src/domain/`:

- `ASSA_LEVEL_TEMPLATE` (`assaLevelTemplate.ts`) — four ordered levels
  (Infants, Beginner, Intermediate, Advanced) with the ratio, age
  bounds, and default progression threshold most starting schools
  want. The Levels-step action `applyAssaDefaults` inserts these as
  `orderIndex 0..3` for an empty school; the prompt only renders when
  the school has zero non-archived levels.
- `ASSA_SKILL_TEMPLATE` (`assaSkillTemplate.ts`) — a curated set of
  skills per ASSA level position. Keyed `Record<0|1|2|3, Skill[]>`,
  matching the level template positions exactly. The Skills-step
  action `applyAssaSkillsForLevel({ levelId })` looks up the level by
  id, reads its `orderIndex`, and inserts
  `ASSA_SKILL_TEMPLATE[orderIndex]` under that level with
  `orderIndex 0..n-1`.

**Position carries semantic meaning, name does not.** The skill
template attaches its skills to the level by `orderIndex`, not by
name — an operator who renames "Beginner" to "Tadpoles" after
applying the level template still gets the position-1 skills attached
when they apply the skill template. Reordering `ASSA_LEVEL_TEMPLATE`
is therefore a breaking change that requires updating
`ASSA_SKILL_TEMPLATE` in lockstep. Always **append** new template
entries (a future fifth ASSA level lands at position 4); never insert
or reorder.

**Position 4+ is template-free territory.** Custom levels the operator
adds beyond the four ASSA defaults sit outside the curated mapping.
`applyAssaSkillsForLevel` refuses (typed `_form` validation error)
when called against a level at `orderIndex >= 4`, and the Skills-step
UI hides the "Use ASSA defaults for this level" affordance for those
levels — the operator gets a "no default template — add manually"
hint and the inline editor instead. The
`hasAssaSkillTemplate(orderIndex)` predicate exported from
`assaSkillTemplate.ts` is the canonical gate.

Concurrency: `apply<Template>Defaults` actions guard against
double-clicks via the existing unique indexes (`(school_id, name)` for
`class_levels`; `(school_id, level_id, name)` for `skills`). The
Prisma `P2002` error is caught at the repository boundary and
re-thrown as a typed `ValidationError` keyed against `name`; the
action layer re-keys it to `_form` for the prompt UX surface so the
operator never sees a raw Postgres error.

## School switcher and last-school cookie

Users can be members of multiple schools. The header in
`src/app/s/[schoolSlug]/layout.tsx` mounts a `<SchoolSwitcher>` server
component (`src/app/s/[schoolSlug]/_components/SchoolSwitcher.tsx`)
that lists every other school the current user belongs to and links to
`/s/<slug>` for each.

### Where memberships come from

`SchoolSwitcher` calls `listUserMemberships(userId)` from
`src/repositories/tenantRepository.ts`. That repository function runs
the `app_list_user_memberships(uuid)` SECURITY DEFINER function — the
same RLS-bypass seam used by the `/` landing page. We deliberately do
**not** introduce a service-role Prisma client to read memberships
unscoped: SECURITY DEFINER keeps the surface area to a known
projection. See `docs/security.md` ("Tenant resolution: a deliberate
RLS bypass") for the full justification.

The component is a server component — no client JS, just a
`<details>`/`<summary>` dropdown — so the membership list never leaves
the server until it's already filtered to the current user.

### The `swp_last_school` cookie

A signed-in user with multiple memberships landing on `/` would see
the picker every time. The `swp_last_school` cookie short-circuits
that: it stores the slug of the most recent tenant the user visited,
and `/` redirects straight there if the slug still matches one of the
user's memberships.

| Concern        | Decision                                                  |
| -------------- | --------------------------------------------------------- |
| Name           | `swp_last_school`                                         |
| Value          | the slug, plain string — no JSON, no signing              |
| Attributes     | `path=/`, `httpOnly`, `sameSite=lax`, `max-age=~1y`       |
| Written        | in `src/middleware.ts` on every `/s/<slug>/...` request   |
| Read           | in `src/app/page.tsx` (the `/` landing)                   |

The cookie is a **UX hint**, not auth. `requireTenant()` and RLS still
gate access; the worst a stale or forged cookie can do is point the
landing page at a slug the user is no longer a member of, which the
landing page guards against by checking the cookie value against the
actual memberships before redirecting. If the cookie names a slug the
user doesn't belong to, `/` falls through to the picker instead.

Middleware is the right place to write the cookie because Next 16's
async `cookies()` store cannot `set` from a page or layout — only from
server actions or route handlers. Middleware runs on every tenant
request anyway and already extracts the slug, so writing the cookie
on the response there is the cleanest seam.

## Domain model — Families and Students

### The aggregate

A `Family` is the household billing identity (billing fields land in
Sprint 3 / Chunk 5; the table is shaped to accept them without
reshuffling). A `Student` belongs to exactly one family and is the unit
of enrolment, attendance, and skill tracking. The relationship is
1 family → many students; students don't move between families inside
this MVP, so we model the FK as `students.family_id` with `ON DELETE
RESTRICT`.

### Domain types vs Prisma types

`src/domain/types.ts` and `src/domain/enums.ts` are the canonical shapes
the rest of the app sees. Repositories under `src/repositories/**` are
the only place allowed to import `@prisma/client`, and each repository
maps Prisma rows to the domain type via a `toFamily(row)` /
`toStudent(row)` helper before returning. **Nothing outside
`src/repositories/**` ever sees a Prisma-generated type** — neither the
row types nor the enum types. The const-object pattern in
`src/domain/enums.ts` (`StudentStatus`, `CommunicationPreference`)
mirrors Prisma's enum string values byte-for-byte, so the mapper can
cast at the boundary without a translation table.

This boundary is the seam where future ORM swaps, additional read
models, or computed/projected fields can land without callers having
to change. Keep `Create…Input` / `Update…Input` types defined inside
the repository file — they describe the repository's contract, not the
domain entity, and don't need to be re-exported.

### Denormalised `students.school_id`

`students.school_id` duplicates `families.school_id`. This is on
purpose: every RLS policy is keyed on `school_id`, and a denormalised
column lets the policy filter without a JOIN against `families`. With
RLS evaluated for every row of every query, that JOIN would land on
the hot path of attendance, enrolment, and dashboard queries.

The cost of denormalisation is a consistency invariant — a student's
school must equal its family's school. We enforce it with a row-level
trigger (`students_school_matches_family`) installed in the
`20260430100000_add_families_and_students` migration. The trigger fires
`BEFORE INSERT OR UPDATE OF school_id, family_id ON students` and
raises `check_violation` if the two diverge. Application code never
needs to repeat the check; the repository's `studentRepository.create`
looks up the family inside the tenant transaction (so RLS scopes the
lookup) and uses its `school_id` directly. The trigger is the
authoritative line of defence — if a future code path forgets that
rule, the database refuses the write rather than allowing a student to
quietly land under the wrong tenant.

The same trigger pattern (BEFORE INSERT/UPDATE, SECURITY DEFINER, narrow
function body, CHECK-violation on mismatch) is reused for class↔location,
class↔level, and class↔teacher-membership invariants on the `classes`
table — see "Domain model — Class levels and classes" below.

## Domain model — Class levels and classes

### Aggregates

A `ClassLevel` defines a school's progression band — Infants, Beginner,
Intermediate, Advanced — and carries the level's teacher-to-student
ratio plus optional age bounds and a per-level "ready to progress"
threshold (skill framework, Chunk 4, will hang off these). A `Class` is
a recurring weekly slot identified by its `(level, day, time, location)`
combination, with a single assigned teacher. There is no name field on
the class — the operator-facing identity is the combination ("Wednesday
4:30pm Infants at Riverside"), and a name would be redundant and prone
to drift.

### Single-teacher MVP

A class carries `teacher_id` directly rather than going through a
`class_teacher_history` join table. Reassignment is an in-place update
on `classes.teacher_id`; the audit fields (`updated_by`, `updated_at`)
record who made the change and when. We don't need historical
teacher-of-record reporting in MVP — when Chunk 3 introduces
`class_sessions`, each session row will capture the teacher who actually
taught that occurrence, which is the load-bearing source of historical
truth (substitute teachers, last-minute swaps). Until then, the audit
fields cover the rare reassignment query.

`teacher_id` is nullable. A class may briefly have no assigned teacher
(between assignments, or pre-onboarding). We model that with `null`
rather than a "TBD" sentinel user so the type system carries the
absence — repositories return `teacherId: string | null` and callers
deal with it explicitly.

### Wall-clock time storage

`classes.start_time` is a Postgres `time` (no date, no timezone) in the
location's timezone. Recurring classes do not store UTC instants —
"Mondays at 4:30pm" is a wall-clock concept; storing it as a UTC instant
would mean rewriting every row twice a year for daylight savings. The
location FK already carries the timezone (`locations.timezone`), so
display code resolves wall-clock + timezone at render. Session-level
instants will live on `class_sessions` (Chunk 3), where a specific date
is involved.

Prisma maps `@db.Time(0)` to a `DateTime` in TypeScript (with the date
component anchored at 1970-01-01 UTC). The `classRepository` converts
to/from an unambiguous `'HH:MM:SS'` string at the boundary — see the
`timeToString` / `stringToTime` helpers in
`src/repositories/classRepository.ts`. The domain `Class` type carries
`startTime: string`, never a `Date`, so callers can't accidentally treat
it as a calendar instant.

### `capacity ≤ level.ratio`

Because we're single-teacher for MVP, a class can never legitimately
seat more students than the level's ratio. We enforce this at the DB
layer in the same `classes_consistency` trigger that does the
cross-school checks — looking up the level row is required for the
school-match check anyway, so the ratio comparison costs nothing extra.
Application repositories don't repeat the check; the trigger is the
authoritative gate. `class_levels.ratio > 0` is a plain CHECK constraint
on `class_levels`.

(Note: the trigger fires on writes to `classes`, not on writes to
`class_levels`. Lowering `class_levels.ratio` below an existing class's
capacity will succeed; the next write to that class would fail. Sprint 6
schedule editing will need to flag this when ratio is reduced.)

### Cross-school consistency triggers

The `classes_consistency` trigger
(`20260430110000_add_class_levels_and_classes`) is a single
`BEFORE INSERT OR UPDATE OF school_id, location_id, level_id,
teacher_id, capacity` function that enforces:

- `class.school_id = location.school_id`
- `class.school_id = level.school_id`
- `class.capacity ≤ level.ratio`
- if `class.teacher_id IS NOT NULL`, a non-deleted `memberships` row
  exists with `(school_id, user_id) = (class.school_id, class.teacher_id)`

Bundled into one function rather than four because the level lookup is
already needed for the school-match check, and a single trigger keeps
the `BEFORE` execution order deterministic. Like
`students_school_matches_family`, it is SECURITY DEFINER so the joins
across `locations`, `class_levels`, and `memberships` aren't filtered by
RLS — tenant isolation on `classes` itself is already done by the
`WITH CHECK` policy; the trigger's only job is the cross-row shape RLS
can't express.

The membership check is intentionally "membership exists, not deleted"
— role is not checked. Role-based authz (who can be assigned as a
teacher) is parking-lot from Sprint 2.

The DB-layer trigger pattern (student↔family, class↔location,
class↔level, class↔teacher-membership) is now established. New
cross-row consistency invariants in Sprint 3+ should follow the same
shape: BEFORE INSERT/UPDATE OF the relevant columns, SECURITY DEFINER
function, narrow body, raise with `ERRCODE = 'check_violation'` on
divergence.

## Domain model — Enrolments and sessions

### The three tables

Sprint 3 / Chunk 3 adds the load-bearing trio that connects students to
classes and records what actually happened:

- `enrolments` — a student's standing booking on a class, with a
  frequency (`weekly`, `fortnightly_a`, `fortnightly_b`, `one_off`),
  start/end dates, an optional pause window, and a denormalised
  `status` (`active` / `paused` / `withdrawn`).
- `class_sessions` — one row per (class, calendar date) the class
  actually runs. Created lazily on first reference, never up front.
- `attendance` — one row per (session, student), with status `present`
  / `absent` / `late` and an optional note.

All three follow the established Sprint 1 conventions: UUID PKs, audit
fields, `deleted_at`, FORCE ROW LEVEL SECURITY scoped on
`app.school_id`, cross-row consistency enforced by `BEFORE
INSERT/UPDATE` SECURITY DEFINER triggers.

### Status is denormalised; dates are the source of truth

Enrolment date columns (`start_date`, `end_date`, `pause_from`,
`pause_to`) are the source of truth. `status` is a denormalised
projection of those dates that we store for query performance — listing
"active enrolments" should be an index seek, not a per-row date
calculation. The DB enforces only **structural** invariants:

- `pause_from IS NULL` ↔ `pause_to IS NULL` (both or neither)
- `pause_to >= pause_from`
- `end_date >= start_date`
- `frequency = 'one_off'` ⇒ `end_date = start_date`
- `status = 'paused'` ⇒ `pause_from IS NOT NULL`

It deliberately does **not** check `now()` against the pause window or
end_date. Two reasons: (1) `now()`-dependent CHECK constraints make the
table hostile to time travel in tests and to backdated edits; (2) the
application owns transitions anyway, via explicit
`pause` / `resume` / `withdraw` repository methods. Those methods set
both the dates and the matching status atomically, and the structural
constraints catch anyone trying to half-write the pair.

### Lazy session materialisation

`class_sessions` rows are written on first reference — when someone
marks attendance, cancels a session, or assigns a substitute teacher.
Pre-materialising the next 12 weeks for every class would burn rows
that may never be touched (a paused enrolment, a class with no marks
yet) and creates a churn hotspot every Monday morning when the next
week rolls in.

`classSessionRepository.getOrCreateSession(tx, classId, sessionDate)`
is the only writer. It is idempotent via the unique
`(class_id, session_date)` constraint: if two requests race, one wins
the insert and the loser catches `P2002` and falls through to a second
SELECT. Callers don't need to coordinate.

The repository also enforces a domain invariant the DB can't:
**session_date must fall on the class's `day_of_week`**. The trigger
`class_sessions_consistency` maps Postgres `EXTRACT(DOW)` (Sunday=0)
back to our `week_day` enum (Monday-first) and rejects mismatches with
`check_violation`. So `getOrCreateSession` never accepts a
"Wednesday" date for a Tuesday class.

### Teacher snapshotting

`class_sessions.teacher_id` is a snapshot of the parent class's
`teacher_id` at session creation time. Once the row exists, reassigning
the class's teacher does **not** propagate to existing sessions. This
is by design: a session row is the historical record of who taught (or
was scheduled to teach) that specific occurrence, and rewriting it
would erase that history. Substitute-teacher overrides in Sprint 6 will
update the session's `teacher_id` directly — at that point the session
row is the single load-bearing source of who taught.

A consequence: backfilling sessions through the repository with the
clock turned forward will pick up whichever teacher is on the class
*right now*, not the one who was assigned at the original session
date. If you ever need historical reassignment fidelity, do it at write
time — once the row is created, the snapshot is frozen.

### Attendance: idempotent upsert, with a domain guard

`attendanceRepository.mark` is an upsert keyed on
`(class_session_id, student_id)`. Marking a student twice replaces the
status — there is no append-only audit of every mark in MVP, only the
final value (and the audit-fields extension stamps `updated_by` /
`updated_at` to record who flipped it). If we need full mark history
later, that's a Sprint 8+ concern; we'd add a separate
`attendance_events` table rather than mutating this contract.

`mark` does an explicit pre-check for cancelled sessions and raises a
typed `ValidationError` rather than relying on a DB constraint. The
reasoning: cancellation is a domain semantic ("this session didn't
happen, so attendance against it is meaningless"), not a structural
invariant — it's the kind of thing a UI wants to surface as a
recoverable user error, not a 500. Auto-completion of a session when
all enrolled students are marked is intentionally *not* done on the
write path: it would force every `mark` call to lock and re-read the
enrolment list, undoing the small-write benefit of the upsert. Manual
`markCompleted` is a separate, explicit action.

Attendance carries a denormalised `student_id` alongside `enrolment_id`
so the row is interpretable even if the enrolment is later withdrawn or
moved between families. The trigger
`app_assert_attendance_consistency` enforces
`enrolment.student_id = attendance.student_id` so the two cannot drift,
and that the school_id agrees across enrolment, session, and student.

### Date expansion is a pure function

`src/domain/enrolment.ts` exports `expandEnrolmentDates(enrolment,
classDayOfWeek, range)` — a pure function with no DB access and no
implicit `now()`. Given an enrolment, the parent class's day-of-week,
and a calendar range, it returns the dates the enrolment "qualifies"
for: the weekly cadence, the fortnightly parity (anchored to the
enrolment's `start_date`), or the single date for a one-off. Pause
windows and end_date short-circuit it inclusively.

This is the seam roster generation, schedule UIs, and "next session
for student X" all share. Because it has no side effects, it is fully
unit-testable (`tests/unit/expandEnrolmentDates.test.ts`) and can be
composed with `classSessionRepository.listByClass` to merge expected
dates with materialised session rows. It must stay pure — if you find
yourself wanting to call the DB or read the wall clock from inside it,
move that decision out to the caller and pass the date range in.

## Domain model — Skills

### The two tables

Sprint 3 / Chunk 4 adds the per-school progression curriculum and the
per-student record of who has achieved what:

- `skills` — a competency within a level. Scoped to `(school_id,
  level_id)`, with `name`, `description`, `order_index`, `is_archived`.
  Same level can hold many skills; the same skill name can recur in
  another level (e.g. "Streamline" in both Beginner and Intermediate).
- `student_skills` — one row per `(student_id, skill_id)`, mutated
  over time. Status is `not_introduced` / `working_on` / `achieved`,
  plus an optional teacher note.

Both follow Sprint 1 conventions: UUID PKs, audit fields, `deleted_at`,
FORCE ROW LEVEL SECURITY scoped on `app.school_id`, cross-row
consistency in `BEFORE INSERT/UPDATE` SECURITY DEFINER triggers.

### Shape A: one row, mutated

`student_skills` is the canonical state, not an append-only event log.
Teachers tap a skill repeatedly during a lesson and we don't want every
tap to write a row; the repository upsert and the audit-fields
extension between them give us "who last set this status, when". If
Sprint 10 wants full progression history we'd add a separate
`student_skill_events` log alongside this table without disturbing the
primary contract.

### Cross-row consistency

Two triggers:

- `skills_consistency` — `skill.school_id = level.school_id`. The
  curriculum a school maintains lives entirely inside that school's
  level framework.
- `student_skills_consistency` — `student_skill.school_id` agrees with
  both `students.school_id` and `skills.school_id`. There is no
  level-reachability rule here: the DB does not check that the student
  is currently enrolled at the level the skill belongs to. That's an
  app concern (a student can validly have skills marked for a level
  they're working through but not yet enrolled in, or a level they've
  graduated from). Keeping the DB permissive lets the UI evolve
  without migration churn.

### `markSkill` is idempotent and ignores no-op taps

`studentRepository.markSkill` reads first, and if the stored status
already matches, returns the existing row without writing. The intent
is purely to avoid bumping `updated_at` / `updated_by` on every
repeated tap — teachers will hit the same skill many times in a
lesson, and we want the audit fields to reflect the last *change*, not
the last touch. The same-status no-op deliberately ignores the `note`
field; if Sprint 7 surfaces a "edit note without changing status" path,
that should route through a separate update method rather than
overloading the tap interaction.

If the row doesn't exist or the status differs, `markSkill` upserts
on the `(student_id, skill_id)` unique index, so a race between two
teachers double-tapping a skill is safe — one wins the insert, the
other lands on the update branch.

### `listSkillsForLevel` is raw SQL on purpose

`studentRepository.listSkillsForLevel(studentId, levelId)` returns one
row per non-archived skill on the level: the student's stored status
if a `student_skills` row exists, or a synthesised
`status: not_introduced` placeholder if it doesn't. The
synthesised rows carry `id: ""` and epoch timestamps so callers can
distinguish them from real rows; persisting an edit through `markSkill`
will create or update the real row.

It's implemented as a single LEFT JOIN in `$queryRaw` rather than
Prisma's `include` because the Sprint 7 progression view will hit this
in a per-student-per-class hot loop. Two round trips (skills, then
student_skills filtered to the studentId) is twice the latency we'd
get from a single JOIN. RLS still applies to both tables — `app.school_id`
filters them inside the JOIN, so a foreign-tenant `studentId` or
`levelId` returns zero rows naturally.

### `is_archived` is soft-retire, not delete

When a school stops teaching a skill, archiving it leaves existing
`student_skills` records intact and queryable, but hides it from the
default `listByLevel` and `listSkillsForLevel` reads. This matters
because progression history is one of the few things teachers and
parents look back on years later — hard-deleting a skill would break
old report cards. Archived skills are included by passing
`includeArchived: true` to `listByLevel`.

## Domain model — Billing primitives

### The four tables (plus a counter)

`billing_profiles`, `invoices`, `invoice_lines`, and `credits` form one
aggregate keyed on the family. They follow the same conventions as
every other Sprint 1–4 table: UUID PKs, audit fields, `deleted_at`,
FORCE ROW LEVEL SECURITY scoped on `current_setting('app.school_id')`,
and `BEFORE INSERT/UPDATE` SECURITY DEFINER triggers for cross-row
consistency. A fifth table, `billing_counters`, holds the per-school
sequential allocator for human-readable invoice numbers; it is
RLS-scoped too and intentionally lacks audit columns because Sprint 8
will mutate it from inside the invoice-create transaction via
`SELECT … FOR UPDATE` and not via a user-triggered code path.

This chunk is **schema only**. A repository surface exists for billing
profile reads + create/update (Sprint 4 onboarding writes the row that
Stripe will attach to in Sprint 8) and for invoice and credit reads.
Invoice generation, line generation, status transitions, credit
creation, and credit application all live in Sprint 8 — none of them
have repository methods today.

### Money is integer cents, full stop

Every monetary column on every billing table is `INTEGER` cents. There
is no `DECIMAL`, no `numeric`, and no `Float` anywhere on the billing
path. This is the whole reason the line-total CHECK looks the way it
does:

    CHECK (line_total_cents = (amount_ex_gst_cents + gst_amount_cents) * quantity)

Integer arithmetic round-trips cleanly across Postgres, Prisma, and the
Stripe API; floats do not. A single `0.1 + 0.2` in the wrong place is
a billing incident waiting to happen, so the type system simply makes
that mistake unrepresentable.

### GST is snapshotted per line

`amount_ex_gst_cents` and `gst_amount_cents` are written at issue time
and immutable thereafter. This matters for two reasons. First, an
invoice is a legal record — the GST it shows must be the GST that
applied to the customer at the moment they were billed, not the GST
in force when someone happens to read the row years later. Second, AU
GST is currently 10% but the framework allows it to change; if it
ever does, historical invoices must continue to show the old rate.
Storing a snapshot rather than computing on read is the only safe
option.

The header `subtotal_cents` / `gst_cents` / `total_cents` are
intentionally duplicated against the line totals. The CHECK
`total_cents = subtotal_cents + gst_cents` catches drift between the
header and the lines if anyone ever writes them inconsistently —
"silent drift" is exactly the failure mode this constraint exists to
prevent.

### One billing profile per family

Enforced by a `UNIQUE INDEX` on `billing_profiles.family_id`, not just
by repository convention. New profiles start at `pending_setup`. Sprint
4 onboarding will create the row at the moment a family signs up, and
Sprint 8's Stripe attach flow will populate `stripe_customer_id` /
`stripe_payment_method_id` and promote `status` to `active`. Status
transitions are NOT enforced at the DB layer — Sprint 8 owns the state
machine.

### Family-level vs student-level credits

`credits.student_id` is nullable. NULL means "applies to any student
in the family"; non-NULL pins the credit to one student (e.g. a
notified-absence credit for one child's missed lesson). The trigger
enforces that when `student_id` is set, `student.family_id` must equal
the credit's `family_id` — a student-level credit cannot belong to
someone outside the family it's attributed to.

`amount_cents` is GST-inclusive and applies against `total_cents` on an
invoice (not against the subtotal). Sprint 8's invoice generator is
responsible for selecting and applying eligible credits; this chunk
exposes only `listAvailableCreditsForFamily(asOf)` for that future
read path.

### Applied state is structural, not a string

The CHECK on `credits` says, in one line:

    (status = 'applied') = (applied_to_invoice_id IS NOT NULL AND applied_at IS NOT NULL)

Both halves of the equivalence have to agree. That catches both
"`status='applied'` but no invoice link" and "linked to an invoice but
status forgot to update" in a single constraint, which is structurally
what we want — these two facts must move together.

### Invoice numbering: per-school counter row

The brief listed three acceptable shapes; we picked the
`billing_counters` table. The reasoning:

- Postgres `SEQUENCE`s are global, ignore RLS, and have allocation
  semantics that don't compose cleanly with `withTenant`. They also
  make per-school numbering awkward — you'd need one sequence per
  school created at school-creation time, which is a footgun.
- `MAX(invoice_number) + 1` reads avoid extra schema but require
  parsing strings and a serializable transaction to be race-free. They
  also conflate "the next number" with "the largest existing number,"
  which breaks if a number is ever reserved without an insert.
- A `billing_counters` table with one row per school lets Sprint 8 do
  `SELECT … FOR UPDATE` inside the same transaction as the invoice
  insert. The lock is row-scoped (so different schools allocate in
  parallel), the counter is RLS-scoped just like every other table,
  and the row's existence is itself an explicit per-school decision.

The counter is created lazily — either by Sprint 8 on first invoice or
by Sprint 4 onboarding alongside the billing profile, depending on
which is simpler at that time.

### What this chunk deliberately does not do

- Generate invoices.
- Apply credits to invoices (no `appliedTo` writes).
- Transition invoice or credit statuses.
- Talk to Stripe.
- Reserve invoice numbers from `billing_counters`.

All of the above belong to Sprint 8 and would be premature here. The
schema, triggers, CHECKs, and reads are everything you need to *write
into* and *render*, but nothing that produces or moves money.

## AI scaffold

### What this is

A thin, instrumented pathway from feature code to Claude. Sprint 3 /
Chunk 6 ships only the plumbing — Sprint 5 (CSV column-mapping during
onboarding) and Sprint 10 (inbox classification + reply suggestions)
are the first features to ride on it. There is no workflow engine, no
prompt framework, no eval harness, no retry layer, no streaming, no
caching, and no output validation in this scaffold. Each of those is a
feature concern that will land where it's actually needed.

### Folder layout

```
src/ai/
  client.ts            # Anthropic SDK singleton
  withAI.ts            # The wrapper — tenant context, hashing, logging
  types.ts             # PromptModule, PromptResult, AICallContext
  prompts/
    system/
      family-summary.ts   # canonical example
    onboarding/        # Sprint 5 will add files here
    inbox/             # Sprint 10 will add files here
```

The `prompts/<feature>/<name>.ts` convention groups by product area.
`system` is for cross-cutting infra prompts (the smoke prompt lives
here). Sprint 5 adds `onboarding/csv-column-map.ts`. Sprint 10 adds
`inbox/classify.ts` and `inbox/suggest-reply.ts`. Each feature folder
owns its own prompts; nothing is shared across features in MVP.

`/ai/` is a peer of `/lib/` and `/repositories/`, not a child of
either. Prompts live inside it because they are tightly coupled to
`PromptModule` and `withAI`; treating them as a domain layer (e.g.
under `/domain/`) would make the SDK leak across module boundaries
the ESLint rule deliberately walls off.

### The `PromptModule` shape

```ts
export interface PromptResult {
  system: string;
  user: string;
  model: string;
  maxTokens: number;
}

export interface PromptModule<TInput> {
  name: string;
  version: number;
  build: (input: TInput) => PromptResult;
}
```

A prompt is a function, not a string. The call site never sees raw
prompt text — it hands `withAI` a typed input and the prompt module
decides what to send. Why:

- **Type safety.** Each prompt declares its own `TInput`; misuse is a
  type error, not a runtime surprise.
- **One audit surface.** Every piece of prompt content lives in
  `src/ai/prompts/`. Future evals, A/B tests, content reviews, and
  internationalisation all instrument one place.
- **Versioning is explicit.** Bump the integer `version` field
  manually when the `build` function's output meaningfully changes.
  We deliberately don't auto-derive a version from the function body
  hash — small refactors that don't change semantics shouldn't churn
  the version, and meaningful semantic changes should be a deliberate
  human signal stamped into the log.

Future capability slots (e.g. an optional Zod output schema, a `tools`
list, an `enableThinking` flag) can land on `PromptModule` as
optional fields without breaking existing modules. Sprint 10 is the
likely first customer.

### The `withAI` contract

```ts
export async function withAI<TInput>(args: {
  feature: string;
  prompt: PromptModule<TInput>;
  input: TInput;
}): Promise<Anthropic.Message>;
```

Behaviour:

1. **Tenant context required.** `withAI` reads `schoolId` and
   `actorId` from AsyncLocalStorage (`src/lib/db/context.ts`), set up
   by the same `withTenant` machinery that scopes every other
   tenant-bound query. If no `schoolId` is bound, `withAI` throws
   `MissingTenantContextError` *before* touching the SDK or the DB.
   AI calls do not happen outside a tenant context.
2. **Input is hashed, not stored.** `sha256(JSON.stringify(input))`
   is what lands in `ai_calls.input_hash`. The raw input never
   touches Postgres. Privacy by default — a future eval pipeline will
   be a deliberate separate decision rather than a slow data
   accumulation.
3. **Prompt is materialised once.** `args.prompt.build(args.input)`
   is called exactly once, before timing starts.
4. **Timing wraps the SDK call only.** The latency we record is
   wall-clock time around `messages.create`, not the wrapper's own
   bookkeeping.
5. **Logging is best-effort.** The `ai_calls` row is written *after*
   the SDK call (success or failure) in a fresh short transaction
   that sets `app.school_id` for RLS. If the log write itself fails,
   we `console.error` and return the SDK response anyway. A logging
   bug must never break a user-facing AI feature. This is also why
   the log write is **not** part of any caller transaction: a
   long-running Claude call holding a Postgres tx open would lock
   rows the upstream caller had updated, which would be a worse
   failure mode than a missing log row.
6. **Original error re-thrown on failure.** `withAI` writes a
   `status='error'` row capturing the truncated error message, then
   re-throws the SDK's original error so callers can pattern-match on
   `Anthropic.APIError` subclasses if they want.
7. **No retries, streaming, output validation, or caching.** Each
   feature concern lives at the call site (or in a future per-feature
   helper) — the wrapper stays thin.

The wrapper's return type is `Anthropic.Message` (from
`@anthropic-ai/sdk`) — concretely the non-streaming response. If a
future SDK upgrade reshapes that type's import path, we'll switch the
wrapper's return to `unknown` and let prompt-specific helpers narrow
it. Don't paper over the moving target with `any`.

### Default model choice

Each prompt picks its own model in the `build` return. Defaults:

- **Classification, structured extraction, anything that's mostly
  reading and labelling** → `claude-haiku-4-5`. Fast and cheap; the
  output shape is known and small. Sprint 5's CSV column map fits
  this. Sprint 10's inbox classifier fits this.
- **Generative replies, summaries with judgement, anything
  user-facing** → `claude-opus-4-7`. Higher quality where the output
  is the product. Sprint 10's reply suggestions fit this.

These are starting points, not rules. A prompt module that needs
something different (e.g. Sonnet for a balance, or a specific snapshot
date for reproducibility) just sets the `model` field accordingly.

### The ESLint boundary

`@anthropic-ai/sdk` imports are restricted to `src/ai/**` (and tests).
The rule is in `eslint.config.mjs` next to the existing Prisma
boundary. Anything outside `src/ai/` that needs Claude calls
`withAI()` — not the SDK directly. This keeps the wrapper as the only
entry point so future cross-cutting concerns (rate limiting, eval
sampling, tracing) can be added in one place without hunting down
direct SDK call sites.

### The `ai_calls` table

One row per call through `withAI`, written best-effort. Columns:

- `school_id` (NOT NULL, FK, RLS-scoped) — the wrapper enforces tenant
  context before the row is written.
- `user_id` (nullable, indexed, **not FK'd**) — captures the actor
  when one exists; null for system jobs. Not FK'd because we want log
  rows to survive user deletion (audit + cost analytics) — the index
  alone is enough.
- `feature` (text) — short identifier, convention `<area>.<purpose>`
  (`inbox.classify`, `onboarding.csv_map`, `system.family_summary`).
  Cost dashboards will group by this column.
- `prompt_name`, `prompt_version` — pulled from the `PromptModule`
  itself, not free-form. This is what makes Sprint 5/10's prompt
  iteration legible after the fact.
- `model` — the exact model string used. Captured from the prompt
  module's `build` output, not hard-coded in the wrapper.
- `input_hash` — SHA-256 hex of the serialised input. The raw input
  is never persisted.
- `input_tokens`, `output_tokens` — from the SDK's `usage` block.
  Nullable because errored calls may not have a usage block.
- `latency_ms` (NOT NULL) — wall-clock time around the SDK call.
- `status` (`ok` | `error`).
- `error_message` (nullable, truncated to 1000 chars at write time).

The load-bearing index for cost dashboards is
`(school_id, feature, created_at desc)`. The
`(school_id, status) WHERE status='error'` partial index makes
"recent failures" queries cheap.

### SDK version pinning

`@anthropic-ai/sdk` is pinned with a tilde range (`~0.92.0`) so patch
upgrades come in but minors don't. SDK upgrades are a deliberate
cross-sprint task, not a routine Dependabot merge — each upgrade must
re-run the `withAI` integration tests and the smoke endpoint, because
the SDK's response and parameter types have moved before. Don't bump
the SDK at the same time as a feature change; do it as its own commit
on its own PR.

### How Sprint 5 will plug in

Sprint 5 adds `src/ai/prompts/onboarding/csv-column-map.ts` exporting
a `PromptModule<CsvColumnMapInput>`. The onboarding handler calls:

```ts
const result = await withAI({
  feature: "onboarding.csv_map",
  prompt: csvColumnMap,
  input: { headers, sampleRows },
});
```

No changes to `withAI`, `client.ts`, the `ai_calls` table, or the
ESLint rule are required. Sprint 5 may want a stable-key stringifier
for `hashInput` (CSV inputs may have ordering noise that should not
produce different hashes) — that lives in `withAI.ts` and is a
~5-line change when needed.

### How Sprint 10 will plug in

Same shape, two prompts:
`src/ai/prompts/inbox/classify.ts` (Haiku) and
`src/ai/prompts/inbox/suggest-reply.ts` (Opus). Inbox handlers call
`withAI({ feature: "inbox.classify", ... })` and
`withAI({ feature: "inbox.suggest_reply", ... })`. Sprint 10 is the
likely point at which `PromptModule` grows an optional output schema
field (Zod or otherwise) — that addition is forward-compatible with
existing modules, which simply don't set it.
