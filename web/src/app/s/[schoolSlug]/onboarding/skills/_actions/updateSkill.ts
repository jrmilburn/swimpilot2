"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { tenantAction } from "@/lib/auth/tenantAction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import * as skillRepository from "@/repositories/skillRepository";
import { UpdateSkillSchema } from "./skillFields";

const Input = z.object({
  id: z.uuid("Invalid skill id"),
  patch: UpdateSkillSchema,
});

/**
 * Partial update on one skill row. RLS scopes the read inside `getById`;
 * if the id doesn't belong to the current tenant the read returns null
 * and we throw `NotFoundError` before attempting the write. Mirrors
 * `updateLevel` from Chunk 4.
 *
 * `levelId` and `orderIndex` are not patchable here — the schema
 * doesn't accept them. Cross-level moves are deliberately not supported
 * (archive-and-recreate is the workflow); reorders go through
 * `reorderSkills`.
 */
export const updateSkill = tenantAction(async ({ tx }, input: unknown) => {
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
    throw new ValidationError(first?.message ?? "Invalid skill", fieldErrors);
  }
  const { id, patch } = parsed.data;

  const existing = await skillRepository.getById(tx, id);
  if (!existing) {
    throw new NotFoundError("Skill not found");
  }

  // Name-uniqueness collisions (`P2002` on `(school_id, level_id, name)`)
  // are mapped to a typed `ValidationError` inside the repository, keyed
  // against `name` — same shape as `addSkill`.
  const updated = await skillRepository.update(tx, id, patch);
  revalidatePath("/s/[schoolSlug]/onboarding/skills", "page");
  return updated;
});
