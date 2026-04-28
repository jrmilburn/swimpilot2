import { resolveSession } from "../auth/session";
import { withTenant, type TenantTx } from "./withTenant";

/**
 * Server-side entry point for any work that touches tenant-scoped data.
 *
 * - Resolves the caller's session (stub: reads from headers; see
 *   `resolveSession`).
 * - Opens a tenant-scoped Prisma transaction with `app.school_id` set.
 * - Verifies the user has a membership in the requested school. The check
 *   runs *inside* the RLS-scoped transaction, so the only memberships
 *   visible are those that match `app.school_id` — meaning a forged
 *   schoolId header naturally fails the lookup.
 * - Runs `fn` inside the same transaction.
 */
export async function getTenantContext<T>(
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const { userId, schoolId } = await resolveSession();

  return withTenant({ userId, schoolId }, async (tx) => {
    const membership = await tx.membership.findFirst({
      where: { userId },
      select: { id: true },
    });

    if (!membership) {
      throw new Error(
        "Forbidden: user is not a member of the requested school",
      );
    }

    return fn(tx);
  });
}
