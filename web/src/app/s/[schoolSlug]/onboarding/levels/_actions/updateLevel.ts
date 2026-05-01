"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { tenantAction } from "@/lib/auth/tenantAction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import * as classLevelRepository from "@/repositories/classLevelRepository";
import { UpdateLevelSchema } from "./levelFields";

const Input = z.object({
  id: z.uuid("Invalid level id"),
  patch: UpdateLevelSchema,
});

/**
 * Partial update on one level row. RLS scopes the read inside `getById`;
 * if the id doesn't belong to the current tenant the read returns null
 * and we throw `NotFoundError` before attempting the write. Mirrors
 * `updateLocation` from Chunk 3.
 *
 * `orderIndex` is not patchable here. Move operations go through
 * `reorderLevels`, which writes the entire ordering atomically.
 */
export const updateLevel = tenantAction(async ({ tx }, input: unknown) => {
  const parsed = Input.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path[issue.path.length - 1];
      if (typeof path === "string" && !fieldErrors[path]) {
        fieldErrors[path] = issue.message;
      }
    }
    const first = parsed.error.issues[0];
    throw new ValidationError(
      first?.message ?? "Invalid level",
      fieldErrors,
    );
  }
  const { id, patch } = parsed.data;

  const existing = await classLevelRepository.getById(tx, id);
  if (!existing) {
    throw new NotFoundError("Level not found");
  }

  // Name-uniqueness collisions (`P2002` on `(school_id, name)`) are
  // mapped to a typed `ValidationError` inside the repository, keyed
  // against `name` — same shape as `addLevel`.
  const updated = await classLevelRepository.update(tx, id, patch);
  revalidatePath("/s/[schoolSlug]/onboarding/levels", "page");
  return updated;
});
