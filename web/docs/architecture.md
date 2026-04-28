# Architecture: data access

## Repository pattern

All database access goes through a **repository layer**. Domain code (server actions, services, route handlers, components) calls repositories — never Prisma directly.

This is enforced by an ESLint rule (`no-restricted-imports`, `error` level) banning imports of:

- `@prisma/client` and its subpaths
- `**/app/generated/prisma/**` (the generated client output, see `prisma/schema.prisma`)
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
