import { withTenant } from "@/lib/db/withTenant";
import { Role } from "@/domain/enums";
import * as pendingInvitationRepository from "@/repositories/pendingInvitationRepository";
import * as membershipRepository from "@/repositories/membershipRepository";
import * as classRepository from "@/repositories/classRepository";

export type ResolvedInvitation = {
  schoolId: string;
  invitationId: string;
  role: Role;
  classesReassigned: number;
};

/**
 * Sign-in-redirect entry point for Clerk-invitation acceptance.
 *
 * Called from the `/` landing page after we've upserted the DB user from
 * the Clerk profile but before listing memberships. The contract:
 *
 *   1. Look up every still-pending `pending_invitations` row matching
 *      this user's lowercased email. The lookup runs as SECURITY DEFINER
 *      because no `app.school_id` is bound yet — see
 *      `app_find_pending_invitations_for_email` in the
 *      Sprint 5 / Chunk 1 migration.
 *   2. For each invitation, run a tenant-scoped transaction against the
 *      invitation's school:
 *        a. Upsert the membership row. ON CONFLICT clears `deleted_at`
 *           — a soft-deleted membership being re-activated by a fresh
 *           invite is a legitimate re-invite flow.
 *        b. Flip the invitation to `accepted` (status, accepted_user_id,
 *           accepted_at).
 *        c. Atomically swap any classes parked on
 *           `pending_teacher_invitation_id = invitation.id` onto
 *           `teacher_id = userId`. The `classes_teacher_xor_pending_check`
 *           CHECK fires on the resulting row, not intermediate state, so a
 *           single UPDATE is safe.
 *
 * Per-school finalisation runs inside its own `withTenant` transaction so
 * a failure in one school's finalisation can't roll back another's. The
 * helper is idempotent: a second call after acceptance finds no
 * `status='pending'` rows and no-ops.
 *
 * Errors are caught per-invitation and logged; the helper never throws
 * to the landing page. Worst case: a freshly-signed-up user lands on the
 * "no schools yet" view and the next sign-in retries. Throwing would
 * paint a 500 over the entire sign-in flow.
 */
export async function resolveAcceptedInvitation(
  userId: string,
  email: string,
): Promise<ResolvedInvitation[]> {
  const pending =
    await pendingInvitationRepository.findPendingForEmailAcrossSchools(email);
  if (pending.length === 0) return [];

  const resolved: ResolvedInvitation[] = [];
  for (const inv of pending) {
    try {
      const result = await finaliseInvitation({
        invitationId: inv.invitationId,
        schoolId: inv.schoolId,
        role: inv.role,
        userId,
      });
      resolved.push(result);
    } catch (err) {
      console.error(
        `resolveAcceptedInvitation: failed to finalise invitation ${inv.invitationId} for school ${inv.schoolId}`,
        err,
      );
    }
  }
  return resolved;
}

type FinaliseInput = {
  invitationId: string;
  schoolId: string;
  role: Role;
  userId: string;
};

async function finaliseInvitation(
  input: FinaliseInput,
): Promise<ResolvedInvitation> {
  const { invitationId, schoolId, role, userId } = input;

  return withTenant({ schoolId, userId }, async (tx) => {
    await membershipRepository.upsertOnAcceptance(tx, {
      schoolId,
      userId,
      role,
    });

    await pendingInvitationRepository.markAccepted(tx, invitationId, userId);

    const classesReassigned =
      await classRepository.swapPendingInvitationToTeacher(
        tx,
        invitationId,
        userId,
      );

    return {
      schoolId,
      invitationId,
      role,
      classesReassigned,
    };
  });
}
