"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import * as skillRepository from "@/repositories/skillRepository";

const Input = z.object({ id: z.uuid("Invalid skill id") });

/**
 * Soft-archive a skill (sets `is_archived = true`). Mirrors
 * `archiveLevel`, but with the `is_archived` boolean rather than
 * `deleted_at` because `student_skills` FKs need to keep referencing
 * archived rows for historical progression.
 *
 * Silently idempotent: archiving an already-archived row, or a row
 * belonging to another tenant (RLS hides it from `getById`), is a
 * `{ archived: false }` no-op rather than a noisy 404.
 *
 * After a real archive, the surviving rows under the same `levelId` are
 * compacted to a dense `orderIndex 0..n-1`. Without compaction, repeated
 * archive cycles would leave gaps in the index space and the next add
 * would land at `count` instead of the natural next slot. Sibling skills
 * under *other* levels are not touched.
 */
export const archiveSkill = tenantAction(async ({ tx }, input: unknown) => {
  const parsed = Input.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid skill id");
  }
  const { id } = parsed.data;

  const existing = await skillRepository.getById(tx, id);
  if (!existing || existing.isArchived) {
    return { archived: false } as const;
  }

  await skillRepository.archive(tx, id);

  // Compact surviving siblings under the same level.
  const survivors = await skillRepository.listByLevel(tx, existing.levelId);
  await skillRepository.reorder(
    tx,
    existing.levelId,
    survivors.map((s) => s.id),
  );

  revalidatePath("/s/[schoolSlug]/onboarding/skills", "page");

  return { archived: true } as const;
});
