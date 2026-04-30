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
