# Tenant isolation & RLS

## Threat model

SwimPilot is multi-tenant: every customer (a "school") shares one Postgres
database. The threat we are protecting against here is **cross-tenant read or
write** — School A's employee, however authenticated, must not be able to
read or modify any row that belongs to School B. This includes:

- direct API misuse (a malicious or buggy client request)
- bugs in our own application code (forgetting a `WHERE school_id = …`)
- compromised app credentials (the attacker's blast radius is one tenant)

Row-Level Security (RLS) is the **primary** defence. Application-side
filtering (`WHERE school_id = …`) is belt-and-braces. If you rely only on
application filtering, a single missing clause is a tenant breach.

## How tenant context flows

Every request that touches tenant data runs inside a Postgres transaction
that has two transaction-local GUCs set as its first statements:

```sql
SELECT set_config('app.school_id', '<uuid>', true);
SELECT set_config('app.user_id',  '<uuid>', true);
```

`set_config(_, _, true)` is `SET LOCAL` you can parameterise — the value
reverts when the transaction commits or rolls back.

Policies on tenant tables match the row's `school_id` against
`NULLIF(current_setting('app.school_id', true), '')::uuid`. The two-arg
form returns NULL when the GUC has never been registered in the session;
the `NULLIF` collapses the empty string Postgres leaves behind on a
pooled connection after a previous `SET LOCAL` reverted. Either way an
unscoped query gets `<uuid> = NULL`, which is NULL, which filters every
row — so a forgotten `withTenant` returns zero rows rather than leaking.

### Why `LOCAL` matters with pooled connections

A pooled connection is reused across requests. If we used a session-level
`SET app.school_id = …`, the next caller that grabs that connection
inherits the previous tenant's context — every request would have to
reset it before doing anything, and any forgotten reset is a breach.

`SET LOCAL` is bound to the current transaction. The moment the
transaction ends (commit or rollback) the value is gone. The next
request opens its own transaction and sets its own value. Pool reuse
becomes safe.

This relies on the pooler being in **session mode** (Supabase port
`5432`) or transaction-pinned for the duration of an interactive
transaction — Prisma's `$transaction` already runs all its queries on
one backend connection, so the GUC stays in scope for every query
inside the callback.

## The non-superuser, non-BYPASSRLS app role

Postgres has a back door: a role with `BYPASSRLS` (or `SUPERUSER`,
which implies it) is exempt from every RLS policy. If the app connects
as that role, RLS is decorative. Hence:

- The app **must** connect as `swimpilot_app`, which is `NOSUPERUSER`,
  `NOBYPASSRLS`, has only the privileges it needs (SELECT/INSERT/
  UPDATE/DELETE on `public.*`), and a unique password.
- The init RLS migration (`20260428200000_enable_rls`) asserts the
  role's `pg_roles` row and raises if either flag is true. Migrations
  fail loudly rather than ship a false sense of security.
- The role is provisioned by `scripts/db/01-create-app-role.sql`. Run
  it once per database as superuser before deploying.

`postgres` (the Supabase project owner) is a superuser. It is fine for
running migrations, ad-hoc admin work, and integration-test fixtures
that need to seed cross-tenant data — but it must **never** be the
DATABASE_URL the Next.js app connects with.

## Middleware: how a request gets scoped

```
HTTP request
  ↓
resolveSession()              ← src/lib/auth/session.ts (stub)
  - returns { userId, schoolId } from headers/cookie
  ↓
getTenantContext(fn)          ← src/lib/db/getTenantContext.ts
  - opens prisma.$transaction(...)
  - SET LOCAL app.school_id, app.user_id (first two statements)
  - validates: SELECT 1 FROM memberships WHERE user_id = $userId
    (this query is itself RLS-scoped to the requested school, so a
    forged schoolId fails the lookup naturally)
  - runs fn(tx)
  ↓
fn(tx) issues normal Prisma queries; every one is RLS-filtered.
```

Two things are stored in `AsyncLocalStorage` so they propagate without
threading through every function:

- `userId` — the audit-fields Prisma extension reads it as the
  `created_by` / `updated_by` value on writes.
- `schoolId` — convenience for code that needs to know its own tenant.

ALS context is set by `runWithTenant`, which `withTenant` calls before
opening the transaction.

## Adding a new tenant-scoped table — checklist

1. Add a `schoolId String @db.Uuid` column on the model in
   `prisma/schema.prisma`, plus the audit fields (`createdAt`,
   `updatedAt`, `createdBy`, `updatedBy`, `deletedAt`).
2. Add `@@index([schoolId])` for query performance.
3. Add the model name to `DOMAIN_MODELS` in
   `src/lib/db/extensions.ts` so the audit extension stamps it.
4. In the next Prisma migration's SQL, after the `CREATE TABLE`:
   ```sql
   ALTER TABLE "<table>" ENABLE ROW LEVEL SECURITY;
   ALTER TABLE "<table>" FORCE ROW LEVEL SECURITY;

   CREATE POLICY "<table>_tenant_isolation" ON "<table>"
     FOR ALL
     USING ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid)
     WITH CHECK ("school_id" = NULLIF(current_setting('app.school_id', true), '')::uuid);
   ```
5. Add a test to `tests/integration/rls.test.ts` that proves both the
   `USING` (read isolation) and `WITH CHECK` (cross-tenant insert
   blocked) sides for the new table. Sanity check by temporarily
   disabling the policy and confirming the test fails.

`FORCE ROW LEVEL SECURITY` is non-optional: without it, the table owner
(the migration role) bypasses RLS, and any code path that runs as the
owner — including some Supabase admin tooling — silently sees
everything.

## Tenant resolution: a deliberate RLS bypass

The post-sign-in landing page (`/`) and the routing layer (`/s/[slug]/`)
have to answer two questions **before** any tenant context exists:

1. "Which schools is this user a member of?" (the landing page picker /
   redirect)
2. "Does the school with this slug exist, and does the caller have an
   active membership in it?" (the `requireTenant()` gate on every
   tenant route)

Both queries hit `schools` and `memberships` — RLS-protected tables.
With no `app.school_id` set, RLS returns zero rows and the query is
useless. We can't set `app.school_id` either, because picking the right
value is the whole point of the lookup. This is a true chicken-and-egg
case where RLS has nothing to enforce yet.

The seam is **two SECURITY DEFINER functions in Postgres**, owned by
the migration role and granted EXECUTE to `swimpilot_app`:

- `app_resolve_tenant(slug text, user_id uuid)` →
  `(school_id uuid, school_name text, role role)`
- `app_list_user_memberships(user_id uuid)` →
  `(school_id, slug, name, role)` for every active membership

`SECURITY DEFINER` makes the function body run with the owner's
privileges, so it sees through RLS — but the **surface area is narrow**.
The app role doesn't get blanket SELECT on `schools` or `memberships`;
it can only invoke these two functions, which return only the projection
each function chose. An attacker who somehow controlled the slug or
user_id arguments still couldn't escalate beyond "see this user's own
memberships and schools."

This is not the same thing as adding a service-role Prisma client. We
considered that and rejected it: a second connection pool with
BYPASSRLS-equivalent privileges is a much bigger blast radius than two
specific functions, and it's easy for future code to reach for the
service-role client when the RLS-scoped path is what's wanted.

Code-side wiring lives in `src/repositories/tenantRepository.ts` —
`lookupTenant()` and `listUserMemberships()`. Both run on the base
Prisma client (the `swimpilot_app` connection) using `$queryRaw` against
the SECURITY DEFINER functions. They're called from
`src/lib/auth/resolveTenant.ts` and `src/lib/auth/requireTenant.ts`.

### 404 vs 403 for unauthorised tenant access

`requireTenant()` decides the response when something goes wrong before
a route renders:

| Situation                                       | Response       |
| ----------------------------------------------- | -------------- |
| Not signed in                                   | redirect `/sign-in` |
| Signed in, slug doesn't exist                   | 404 (`notFound()`)  |
| Signed in, slug exists, user is not a member    | 404 (`notFound()`)  |
| Signed in, slug exists, user is a member        | route renders       |

We deliberately collapse "no membership" (would naturally be 403) into
"not found" (404). Returning a 403 for slugs the user doesn't belong to
would let a signed-in user enumerate the set of valid school slugs by
probing URLs and watching for the status flip from 404 → 403. Slugs are
short, public-facing strings; we don't want them to be a discovery
oracle. Treating both as 404 is the conservative choice and the cost is
negligible — a member of School A typing in School B's URL was probably
never going to see anything useful anyway.

If we ever need to surface a friendlier "you're not a member of this
school" message (e.g. for invite-link flows), the right answer is a
distinct route (`/invite/[token]`) — not a 403 on `/s/[slug]`.

### Defence-in-depth: actor stamping

`requireTenant()` calls `setRequestActor(userId, schoolId)` on success
(`src/lib/db/context.ts`). That uses `AsyncLocalStorage.enterWith`,
binding the actor for the rest of the current async chain — meaning the
audit-fields Prisma extension, when it runs underneath any repository
call later in the same render, stamps `created_by` / `updated_by` with
the real DB user id rather than `SYSTEM_USER_ID`.

`enterWith` is safe here because Next.js opens a fresh async context
root per request render; there's no cross-request bleed.

## What is NOT RLS-protected

- **`users`**: a single human can be a member of multiple schools.
  Their identity is global; isolation happens via the `memberships`
  join, which IS RLS-scoped. Putting RLS on `users` would either
  require the user to scope to a school before authentication
  (chicken-and-egg) or allow cross-tenant user enumeration via email.
- **The DB owner / superuser** (`postgres` on Supabase). Migrations,
  admin tooling, and seed fixtures run as this role and are exempt
  from RLS. The application code path never uses these credentials.

## Verifying

- Integration tests: `npm run test:db:up && npm run test:db:migrate && npm run test`
- The RLS suite (`tests/integration/rls.test.ts`) covers SELECT,
  cross-tenant WHERE, INSERT WITH CHECK, UPDATE, and the unset-context
  case. Toggling RLS off on `locations` makes all five fail — that's
  the periodic sanity check that the tests test what they claim.

## DB-layer invariants beyond RLS

RLS scopes who sees what; some tenant-correctness invariants don't fit
the RLS shape and live as triggers instead. Document them here so they
aren't forgotten the next time someone touches the schema.

### `students.school_id` must match `families.school_id`

`students.school_id` is denormalised so RLS policies can filter without
a JOIN (see `docs/architecture.md` → "Denormalised `students.school_id`"
for the why). The pair is held consistent by a `BEFORE INSERT OR UPDATE
OF school_id, family_id` trigger (`students_school_matches_family`)
defined in the `20260430100000_add_families_and_students` migration.

Why a DB-layer trigger instead of an application check:

- A trigger fires on every write path — Prisma, raw SQL in seeds,
  ad-hoc `psql` work, future bulk-import jobs. An application check
  only fires from the code paths that remember to run it.
- RLS already passes a row whose `school_id` matches the current
  tenant context. If a buggy code path passed a `family_id` from a
  different tenant whose `school_id` happened to match the current
  context (it won't under RLS, but defence-in-depth), the trigger
  still blocks the write.
- Expressing this in Prisma's schema-level constructs would mean a
  computed `CHECK` referencing another table, which Postgres doesn't
  allow. A trigger is the natural fit.

The trigger is `SECURITY DEFINER` so its `SELECT` against `families`
isn't itself filtered by the same RLS policy that's gating the row
being inserted. The function's body is a single lookup and a comparison
— the surface area is intentionally tiny.

### `classes.school_id` matches `locations`, `class_levels`, and assigned teacher's membership

`classes` carries three FKs that each have a corresponding tenant
constraint that RLS alone can't express: a class's `location_id` and
`level_id` must point at rows of the same school, and (if the class has
a teacher) the teacher must hold a non-deleted `memberships` row in the
same school. Additionally, `classes.capacity` must not exceed the
linked level's `ratio` (single-teacher MVP — see
`docs/architecture.md`).

These four invariants are enforced by `app_assert_class_consistency()`,
fired by `classes_consistency BEFORE INSERT OR UPDATE OF
school_id, location_id, level_id, teacher_id, capacity ON classes`,
defined in `20260430110000_add_class_levels_and_classes`. Same
properties as `students_school_matches_family`: SECURITY DEFINER, a
narrow function body that does only the lookups and comparisons it
needs, raises `check_violation` on divergence and `foreign_key_violation`
when a referenced row is missing.

The membership check enforces "is a member, not soft-deleted" — role
is not checked. Role-based authz on who may be assigned as a teacher
is an application-layer concern parked from Sprint 2. The trigger only
guarantees that a teacher_id, when set, points at someone with
standing in the school.

One caveat to flag: the trigger does not fire on writes to
`class_levels`, only on writes to `classes`. If a level's `ratio` is
lowered below an existing class's `capacity`, the level update
succeeds; the inconsistency is only caught on the next write to that
class. Schedule-editing UI (Sprint 6) needs to surface the impact
before allowing a ratio reduction. We chose not to add a defensive
trigger on `class_levels.ratio` because the alternative — scanning
every class on each level update — pays write cost for an invariant
that only operator-driven flows can violate.

### `classes` atomic-swap on assignment

`classes` carries two mutually exclusive teacher columns: `teacher_id`
(the real, signed-up teacher) and `pending_teacher_invitation_id` (a
class "parked" on a pending invitation that resolves into a real
teacher when the invitee accepts). A `CHECK` constraint —
`NOT (teacher_id IS NOT NULL AND pending_teacher_invitation_id IS NOT NULL)`
— rejects rows that have both populated.

The constraint dictates a write contract: every assignment change
must be a single UPDATE that sets both columns at once. Two
sequential UPDATEs (clear one, then set the other) leave the row in a
mid-state where both are null — fine for `CHECK` but visible to other
transactions and a step backward in our invariant chain. The
`assignTeacherToClass` and `unassignTeacherFromClass` actions, plus
the invitation-acceptance handler in `resolveAcceptedInvitation`, all
issue exactly one UPDATE per swap.

## Pending invitations: cross-tenant lookup at sign-in

When an operator invites a teacher by email, two rows land:

1. A Clerk invitation (so the invitee gets the email + magic link).
2. A `pending_invitations` row in `swimpilot_app`'s database, scoped
   to the inviting school, with `status='pending'` and a
   `clerk_invitation_id` cross-reference.

When the invitee follows the magic link and signs in for the first
time, the app needs to:

- find every pending invitation for **their email address** across
  every school they've been invited to (a single user can be invited
  to multiple schools before their first sign-in),
- create membership rows in each of those schools,
- mark each invitation as accepted,
- transfer any classes parked on that invitation onto the new
  membership.

The lookup in step 1 is the same shape as `app_resolve_tenant`: it
must read across schools **before** any tenant context can be set.
With no `app.school_id`, RLS on `pending_invitations` returns zero
rows. We can't pick a school to scope to — the whole point is to
discover which schools the invitee belongs in.

The seam is a third SECURITY DEFINER function alongside
`app_resolve_tenant` and `app_list_user_memberships`:

- `app_find_pending_invitations_for_email(p_email text)` →
  `(invitation_id uuid, school_id uuid, role role, email citext)`
  rows for every `status='pending' AND deleted_at IS NULL`
  invitation whose lower-cased email matches the argument.

The same trade-off applies as the other two functions: the app role
gets EXECUTE on this function, not blanket SELECT on
`pending_invitations`. The projection is fixed (no full row), and the
filter is hardcoded to `status='pending'` so the function can't be
coaxed into surfacing accepted/revoked rows. The function is defined
in the chunk migration that introduces `pending_invitations`
(`20260525120000_add_pending_invitations_and_class_pending_teacher`).

### Why sign-in-redirect, not a webhook

Clerk emits webhook events when an invitation is accepted; the
obvious alternative is to listen for the webhook and run the
acceptance machinery off-band. We chose against it:

- A webhook handler is a new public endpoint with its own
  authentication story (signature verification) and its own failure
  mode (delivery retries, ordering). The sign-in-redirect path uses
  the same Clerk session the user already authenticated with — no
  extra surface.
- The acceptance work has to happen synchronously anyway: the user
  expects to land on the school dashboard in their first request, not
  whenever the webhook eventually delivers. A webhook would force a
  "you're being set up, please refresh" interstitial.
- Clerk's webhook event contains the invitation id but not the email;
  matching across schools still needs the same `app_find_pending_…`
  lookup. The webhook path gains us nothing beyond a second code path
  that has to stay in sync.

The handler lives in `src/lib/auth/resolveAcceptedInvitation.ts` and
is invoked from the post-sign-in landing page (`src/app/page.tsx`)
between resolving the DB user and listing memberships. Each
invitation is processed in its own `withTenant` transaction so a
failure in one school's acceptance doesn't roll back the others.
