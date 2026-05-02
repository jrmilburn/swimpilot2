"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { clerkClient } from "@clerk/nextjs/server";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import * as pendingInvitationRepository from "@/repositories/pendingInvitationRepository";
import { Role } from "@/domain/enums";

// `email` is normalised to lowercase at the repository boundary; the
// `pending_invitations.email_lower_check` CHECK enforces it. Trim
// whitespace before normalising — operators paste from address books.
const Input = z.object({
  email: z
    .string({ message: "Email is required" })
    .trim()
    .min(1, "Email is required")
    .email("Enter a valid email address")
    .max(254, "Email is too long"),
});

/**
 * Invite a single teacher to the current school.
 *
 * Order of operations:
 *   1. Pre-check for an existing pending invitation under
 *      `(school_id, lower(email))`. The partial unique index protects
 *      this at the DB layer — `pendingInvitationRepository.create`
 *      maps the `P2002` to a typed `ValidationError` — but the
 *      pre-check surfaces a friendlier message before we hit Clerk.
 *   2. Call Clerk's `invitations.createInvitation` to send the email.
 *      This must happen *before* the DB write so a Clerk failure
 *      doesn't leave a row referencing a non-existent invitation.
 *   3. Persist the `pending_invitations` row with the Clerk
 *      `invitation.id` so the revoke action can flip both Clerk and
 *      our row in lockstep.
 *
 * Public sign-up URL is `/sign-up` — Clerk handles the magic-link
 * landing and redirects to `/` on completion. The
 * `resolveAcceptedInvitation` helper at `/` finalises the membership
 * and atomically swaps any classes parked on the invitation onto the
 * new teacher.
 */
export const inviteTeacher = tenantAction(
  async ({ tx, schoolId, userId }, input: unknown) => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path[issue.path.length - 1];
        if (typeof path === "string" && !fieldErrors[path]) {
          fieldErrors[path] = issue.message;
        }
      }
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? "Invalid invitation",
        fieldErrors,
      );
    }
    const email = parsed.data.email.toLowerCase();

    const duplicate = await pendingInvitationRepository.getPendingByEmail(
      tx,
      email,
    );
    if (duplicate) {
      throw new ValidationError(
        "An invitation is already pending for that email.",
        { email: "An invitation is already pending for that email." },
      );
    }

    // Clerk-side: send the invite. The redirect URL takes the operator
    // to `/` — the landing page's `resolveAcceptedInvitation` runs
    // there. We pin a publicMetadata with the `schoolId` for
    // traceability; the actual finalisation reads off the
    // `pending_invitations` row, not the Clerk metadata.
    const clerk = await clerkClient();
    let clerkInvitation: { id: string };
    try {
      clerkInvitation = await clerk.invitations.createInvitation({
        emailAddress: email,
        redirectUrl: process.env.CLERK_INVITATION_REDIRECT_URL ?? undefined,
        publicMetadata: { schoolId, role: Role.Teacher },
      });
    } catch (err) {
      console.error("[inviteTeacher] Clerk invitation failed", err);
      throw new ValidationError(
        "Could not send the invitation right now. Try again in a minute.",
        {
          _form:
            "Could not send the invitation right now. Try again in a minute.",
        },
      );
    }

    const created = await pendingInvitationRepository.create(tx, {
      email,
      role: Role.Teacher,
      invitedByUserId: userId,
      clerkInvitationId: clerkInvitation.id,
    });

    revalidatePath("/s/[schoolSlug]/onboarding/teachers", "page");
    return created;
  },
);
