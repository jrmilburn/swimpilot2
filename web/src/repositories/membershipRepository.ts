import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/db/client";
import type { TenantTx } from "../lib/db/withTenant";
import { Role } from "../domain/enums";

export type DbClient = TenantTx | typeof prisma;

// Shape returned to callers — denormalised "membership + user" row, since
// the Teachers roster always wants both. Keeping it as a flat record (not
// nested) matches the repository convention of yielding plain domain
// shapes; the underlying join is an internal detail.
export type MembershipWithUser = {
  membershipId: string;
  schoolId: string;
  userId: string;
  role: Role;
  email: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
};

type Row = Prisma.MembershipGetPayload<{
  include: { user: { select: { id: true; email: true; name: true } } };
}>;

function toMembershipWithUser(row: Row): MembershipWithUser {
  return {
    membershipId: row.id,
    schoolId: row.schoolId,
    userId: row.userId,
    role: row.role as Role,
    email: row.user.email,
    name: row.user.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * List active memberships for the calling tenant filtered by role,
 * eager-loading the joined user. RLS scopes the read to the calling
 * school — `users` is intentionally not under RLS, but the FK join
 * cannot reach a user who isn't connected via a membership row, so the
 * surface stays tenant-safe.
 *
 * Soft-deleted memberships are excluded by default (the wizard's
 * Teachers roster doesn't surface them). Sorted by creation order so
 * "first invited" reads at the top.
 */
export async function listByRole(
  db: DbClient,
  role: Role,
): Promise<MembershipWithUser[]> {
  const rows = await db.membership.findMany({
    where: {
      role: role as Prisma.MembershipWhereInput["role"],
      deletedAt: null,
    },
    include: {
      user: { select: { id: true, email: true, name: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toMembershipWithUser);
}

/**
 * Sign-in-redirect helper: insert (or re-activate) a membership row when
 * a Clerk-invited user accepts and lands on `/`.
 *
 * `ON CONFLICT (school_id, user_id) DO UPDATE` clears `deleted_at` so a
 * soft-deleted membership being re-invited is re-activated. Role is
 * deliberately preserved on conflict — operators may have intentionally
 * adjusted role after the original invite, and a re-invite is not the
 * right place to silently change it.
 *
 * Audit-fields stamping is bypassed here in favour of explicit
 * `created_by` / `updated_by` parameters because this runs inside a
 * tenant tx where the actor is the user accepting their own invite.
 */
export async function upsertOnAcceptance(
  db: TenantTx,
  input: { schoolId: string; userId: string; role: Role },
): Promise<void> {
  const { schoolId, userId, role } = input;
  await db.$executeRaw`
    INSERT INTO memberships (school_id, user_id, role, created_by, updated_by, updated_at)
    VALUES (${schoolId}::uuid, ${userId}::uuid, ${role}::role, ${userId}::uuid, ${userId}::uuid, now())
    ON CONFLICT (school_id, user_id) DO UPDATE
      SET deleted_at = NULL,
          updated_at = now(),
          updated_by = ${userId}::uuid
  `;
}
