import { Prisma } from "@prisma/client";
import { prisma } from "../lib/db/client";
import { getSchoolId } from "../lib/db/context";
import type { TenantTx } from "../lib/db/withTenant";
import type { PendingInvitation } from "../domain/types";
import { Role } from "../domain/enums";
import type { PendingInvitationStatus } from "../domain/enums";
import { ValidationError } from "../lib/errors";

export type DbClient = TenantTx | typeof prisma;

/**
 * Cross-tenant lookup for sign-in-redirect invitation acceptance.
 *
 * Wraps the `app_find_pending_invitations_for_email` SECURITY DEFINER
 * function — see `docs/security.md` for the full rationale. Callable
 * outside any tenant context (the function reads through RLS).
 *
 * Returns one row per still-pending invitation matching the lowercased
 * email. The caller (`resolveAcceptedInvitation`) wraps each row in its
 * own `withTenant` transaction to finalise.
 */
export type CrossTenantPendingMatch = {
  invitationId: string;
  schoolId: string;
  role: Role;
  email: string;
};

type CrossTenantRow = {
  invitation_id: string;
  school_id: string;
  role: Role;
  email: string;
};

export async function findPendingForEmailAcrossSchools(
  email: string,
): Promise<CrossTenantPendingMatch[]> {
  const normalised = email.toLowerCase();
  const rows = await prisma.$queryRaw<CrossTenantRow[]>`
    SELECT invitation_id, school_id, role, email
    FROM app_find_pending_invitations_for_email(${normalised})
  `;
  return rows.map((r) => ({
    invitationId: r.invitation_id,
    schoolId: r.school_id,
    role: r.role,
    email: r.email,
  }));
}

export type CreatePendingInvitationInput = {
  email: string;
  role: Role;
  invitedByUserId: string;
  clerkInvitationId?: string | null;
  expiresAt?: Date | null;
};

export type ListBySchoolOptions = {
  // Default `false` filters to status = 'pending', which is what the
  // Teachers step roster wants. Pass `true` to surface the historical
  // accepted / revoked / expired rows for an audit screen.
  includeNonPending?: boolean;
};

type PendingInvitationRow = Prisma.PendingInvitationGetPayload<
  Record<string, never>
>;

function toPendingInvitation(row: PendingInvitationRow): PendingInvitation {
  return {
    id: row.id,
    schoolId: row.schoolId,
    email: row.email,
    role: row.role as Role,
    clerkInvitationId: row.clerkInvitationId,
    invitedByUserId: row.invitedByUserId,
    status: row.status as PendingInvitationStatus,
    acceptedUserId: row.acceptedUserId,
    acceptedAt: row.acceptedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Partial unique index `(school_id, lower(email)) WHERE status='pending'
// AND deleted_at IS NULL`. Prisma raises P2002 for any insert that
// collides; we map it to a typed `ValidationError` against the `email`
// field so the action layer doesn't need to know about Prisma error
// codes.
const PRISMA_UNIQUE_VIOLATION = "P2002";

function mapUniqueViolation(err: unknown): never {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === PRISMA_UNIQUE_VIOLATION
  ) {
    throw new ValidationError(
      "An invitation is already pending for that email.",
      {
        email: "An invitation is already pending for that email.",
      },
    );
  }
  throw err;
}

export async function getById(
  db: DbClient,
  id: string,
): Promise<PendingInvitation | null> {
  const row = await db.pendingInvitation.findUnique({ where: { id } });
  if (!row) return null;
  if (row.deletedAt) return null;
  return toPendingInvitation(row);
}

/**
 * Find the single live pending invitation for `(schoolId, email)` — i.e.
 * the row that the partial unique index protects. Used by the Teachers
 * step's invite flow to refuse a duplicate before hitting Clerk, and by
 * `resolveAcceptedInvitation` to find the row to flip on sign-up.
 *
 * Email is normalised to lowercase to match the
 * `email = lower(email)` CHECK constraint.
 */
export async function getPendingByEmail(
  db: DbClient,
  email: string,
): Promise<PendingInvitation | null> {
  const normalised = email.toLowerCase();
  const row = await db.pendingInvitation.findFirst({
    where: {
      email: normalised,
      status: "pending",
      deletedAt: null,
    },
  });
  return row ? toPendingInvitation(row) : null;
}

export async function listBySchool(
  db: DbClient,
  options: ListBySchoolOptions = {},
): Promise<PendingInvitation[]> {
  const where: Prisma.PendingInvitationWhereInput = { deletedAt: null };
  if (!options.includeNonPending) {
    where.status = "pending";
  }
  const rows = await db.pendingInvitation.findMany({
    where,
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toPendingInvitation);
}

export async function create(
  db: DbClient,
  input: CreatePendingInvitationInput,
): Promise<PendingInvitation> {
  const schoolId = getSchoolId();
  if (!schoolId) {
    throw new Error(
      "pendingInvitationRepository.create: no schoolId in tenant context; call inside withTenant()",
    );
  }
  const data = {
    schoolId,
    email: input.email.toLowerCase(),
    role: input.role,
    invitedByUserId: input.invitedByUserId,
    clerkInvitationId: input.clerkInvitationId ?? null,
    expiresAt: input.expiresAt ?? null,
  } as unknown as Prisma.PendingInvitationCreateInput;

  try {
    const row = await db.pendingInvitation.create({ data });
    return toPendingInvitation(row);
  } catch (err) {
    mapUniqueViolation(err);
  }
}

/**
 * Flip a pending row to `accepted`, recording which user accepted it and
 * when. Idempotent at the repository boundary in the sense that a second
 * call with a different `acceptedUserId` will still update — the calling
 * helper (`resolveAcceptedInvitation`) is responsible for only calling
 * once per (invitation, user). The
 * `pending_invitations_accepted_consistency_check` CHECK constraint
 * guarantees the row stays internally consistent.
 */
export async function markAccepted(
  db: DbClient,
  id: string,
  acceptedUserId: string,
  acceptedAt: Date = new Date(),
): Promise<PendingInvitation> {
  const row = await db.pendingInvitation.update({
    where: { id },
    data: {
      status: "accepted",
      acceptedUserId,
      acceptedAt,
    },
  });
  return toPendingInvitation(row);
}

export async function markRevoked(
  db: DbClient,
  id: string,
): Promise<PendingInvitation> {
  const row = await db.pendingInvitation.update({
    where: { id },
    data: { status: "revoked" },
  });
  return toPendingInvitation(row);
}

export async function markExpired(
  db: DbClient,
  id: string,
): Promise<PendingInvitation> {
  const row = await db.pendingInvitation.update({
    where: { id },
    data: { status: "expired" },
  });
  return toPendingInvitation(row);
}
