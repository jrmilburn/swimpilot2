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
