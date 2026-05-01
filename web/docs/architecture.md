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
