import { prisma } from "./client";
import { runWithTenant } from "./context";

/**
 * Transaction client carried through `withTenant` callbacks. Inferred from
 * the extended Prisma client so the audit-fields extension is preserved on
 * `tx` (and so we don't fight Prisma's overloaded `$transaction` types).
 */
export type TenantTx = Parameters<
  Parameters<(typeof prisma)["$transaction"]>[0]
>[0];

/**
 * Run `fn` against a Prisma transaction with tenant context bound.
 *
 * The first statements in the transaction set `app.school_id` and
 * `app.user_id` as transaction-local GUCs (via `set_config(_, _, true)`,
 * which is `SET LOCAL` you can parameterise). Every subsequent query in the
 * transaction is matched by RLS policies against `app.school_id`.
 *
 * The same ids are also placed in AsyncLocalStorage so the audit-fields
 * Prisma extension can stamp `created_by` / `updated_by` without callers
 * having to thread the user id through every call site.
 */
export async function withTenant<T>(
  args: { schoolId: string; userId: string },
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const { schoolId, userId } = args;

  return runWithTenant({ actorId: userId, schoolId }, () =>
    prisma.$transaction(async (tx) => {
      // Bind tenant context for the lifetime of this transaction. Must be
      // the first statements: anything earlier would run unscoped and could
      // accidentally leak across tenants.
      await tx.$executeRaw`SELECT set_config('app.school_id', ${schoolId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;

      return fn(tx);
    }),
  );
}
