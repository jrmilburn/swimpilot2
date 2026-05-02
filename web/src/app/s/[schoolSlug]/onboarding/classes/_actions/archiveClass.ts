"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { tenantAction } from "@/lib/auth/tenantAction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import * as classRepository from "@/repositories/classRepository";

const Input = z.object({ id: z.uuid("Invalid class id") });

/**
 * Soft-delete a single class row. Mirrors `archiveLocation` /
 * `archiveSkill`: the repository sets `deleted_at = now()` and the
 * read paths filter the row out by default.
 *
 * "No-op when already archived" lives here, not in the repository:
 * the repository's `getById` returns `null` for soft-deleted rows so
 * a second archive surfaces as `NotFoundError` to the action layer,
 * which is the right UX (the row is already gone from the operator's
 * view).
 */
export const archiveClass = tenantAction(async ({ tx }, input: unknown) => {
  const parsed = Input.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid class id");
  }
  const { id } = parsed.data;

  const existing = await classRepository.getById(tx, id);
  if (!existing) throw new NotFoundError("Class not found");

  const archived = await classRepository.archive(tx, id);

  revalidatePath("/s/[schoolSlug]/onboarding/classes", "page");
  revalidatePath("/s/[schoolSlug]/onboarding/teachers", "page");
  return archived;
});
