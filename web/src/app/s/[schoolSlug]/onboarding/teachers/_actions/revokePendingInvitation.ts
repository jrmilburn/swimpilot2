"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { clerkClient } from "@clerk/nextjs/server";
import { tenantAction } from "@/lib/auth/tenantAction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import * as pendingInvitationRepository from "@/repositories/pendingInvitationRepository";

const Input = z.object({ invitationId: z.uuid("Invalid invitation id") });

/**
 * Revoke a pending invitation. Two-step:
 *
 *   1. Best-effort Clerk-side revoke. If the row was created without a
 *      Clerk id (graceful-degradation case from `inviteTeacher`), or
 *      Clerk is unreachable, log and continue — the local row is the
 *      source of truth for whether the invitation is acceptable, and
 *      `resolveAcceptedInvitation` filters on `status='pending'`.
 *   2. Flip our row to `status='revoked'`. Any classes parked on this
 *      invitation are atomically cleared so the operator can re-assign
 *      them. (`pendingTeacherInvitationId` is set null on those rows
 *      via `updateMany` — same single-UPDATE pattern as the swap in
 *      `resolveAcceptedInvitation`.)
 */
export const revokePendingInvitation = tenantAction(
  async ({ tx }, input: unknown) => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Invalid invitation id");
    }
    const { invitationId } = parsed.data;

    const inv = await pendingInvitationRepository.getById(tx, invitationId);
    if (!inv) throw new NotFoundError("Invitation not found");
    if (inv.status !== "pending") {
      throw new ValidationError(
        "That invitation is no longer pending — refresh and try again.",
      );
    }

    if (inv.clerkInvitationId) {
      try {
        const clerk = await clerkClient();
        await clerk.invitations.revokeInvitation(inv.clerkInvitationId);
      } catch (err) {
        console.error(
          `[revokePendingInvitation] Clerk revoke failed for ${inv.clerkInvitationId}`,
          err,
        );
        // Continue. The DB row is the source of truth.
      }
    }

    // Clear classes parked on this invitation BEFORE flipping the
    // status. The `classes_consistency` trigger forbids
    // `pending_teacher_invitation_id` pointing at a non-pending row,
    // so leaving classes attached after the flip would put the DB in a
    // state that re-validates as a `check_violation` on the next
    // class update.
    await tx.class.updateMany({
      where: {
        pendingTeacherInvitationId: invitationId,
        deletedAt: null,
      },
      data: { pendingTeacherInvitationId: null },
    });

    const updated = await pendingInvitationRepository.markRevoked(
      tx,
      invitationId,
    );

    revalidatePath("/s/[schoolSlug]/onboarding/teachers", "page");
    return updated;
  },
);
