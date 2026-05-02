"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { tenantAction } from "@/lib/auth/tenantAction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import * as classRepository from "@/repositories/classRepository";
import * as pendingInvitationRepository from "@/repositories/pendingInvitationRepository";

// Discriminated union — pick exactly one assignee shape.
//   `{ kind: 'teacher',  teacherId }`     → real membership.
//   `{ kind: 'pending',  invitationId }`  → park on a pending invite.
// `unassignTeacherFromClass` is a separate action; merging "no
// assignment" into this one would let the form silently clear an
// existing assignment if the dropdown were submitted blank.
const Input = z.object({
  classId: z.uuid("Invalid class id"),
  assignment: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("teacher"), teacherId: z.uuid() }),
    z.object({ kind: z.literal("pending"), invitationId: z.uuid() }),
  ]),
});

/**
 * Assign a class to either a real teacher (membership) or a pending
 * invitation. The `classes_teacher_xor_pending_check` CHECK on
 * `classes` refuses both being non-null at once; this action sets one
 * and explicitly nulls the other in a single UPDATE so the CHECK fires
 * on the resulting row, not intermediate state.
 *
 * Cross-tenant defence: `classRepository.getById` and the pending
 * invitation lookup both run inside the tenant tx, so RLS scopes the
 * read. The trigger is the second line of defence and would raise on
 * a teacher whose membership is in another school or an invitation
 * whose school doesn't match the class's school.
 */
export const assignTeacherToClass = tenantAction(
  async ({ tx }, input: unknown) => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Invalid assignment");
    }
    const { classId, assignment } = parsed.data;

    const cls = await classRepository.getById(tx, classId);
    if (!cls) throw new NotFoundError("Class not found");

    if (assignment.kind === "pending") {
      const inv = await pendingInvitationRepository.getById(
        tx,
        assignment.invitationId,
      );
      if (!inv) throw new NotFoundError("Invitation not found");
      if (inv.status !== "pending") {
        throw new ValidationError(
          "That invitation is no longer pending — refresh and try again.",
        );
      }
    }

    const updated = await classRepository.update(tx, classId, {
      teacherId: assignment.kind === "teacher" ? assignment.teacherId : null,
      pendingTeacherInvitationId:
        assignment.kind === "pending" ? assignment.invitationId : null,
    });

    revalidatePath("/s/[schoolSlug]/onboarding/teachers", "page");
    return updated;
  },
);
