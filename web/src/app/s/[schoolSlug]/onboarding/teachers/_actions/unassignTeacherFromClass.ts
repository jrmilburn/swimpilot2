"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { tenantAction } from "@/lib/auth/tenantAction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import * as classRepository from "@/repositories/classRepository";

const Input = z.object({ classId: z.uuid("Invalid class id") });

/**
 * Clear both `teacher_id` and `pending_teacher_invitation_id` on a
 * class. Idempotent — if the class is already unassigned the UPDATE
 * is a no-op at the row level.
 */
export const unassignTeacherFromClass = tenantAction(
  async ({ tx }, input: unknown) => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Invalid class id");
    }
    const { classId } = parsed.data;

    const cls = await classRepository.getById(tx, classId);
    if (!cls) throw new NotFoundError("Class not found");

    const updated = await classRepository.update(tx, classId, {
      teacherId: null,
      pendingTeacherInvitationId: null,
    });

    revalidatePath("/s/[schoolSlug]/onboarding/teachers", "page");
    return updated;
  },
);
