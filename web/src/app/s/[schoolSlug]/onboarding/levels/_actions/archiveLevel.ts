"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import * as classLevelRepository from "@/repositories/classLevelRepository";

const Input = z.object({ id: z.uuid("Invalid level id") });

/**
 * Soft-delete a level. Mirrors `archiveLocation`:
 *   - Silently idempotent: archiving an already-archived row, or a row
 *     belonging to another tenant (RLS hides it from `getById`), is a
 *     `{ archived: false }` no-op rather than a noisy 404.
 *   - Returns `{ archived: true | false }` so tests can distinguish the
 *     two paths.
 *
 * After a real archive, the surviving rows are compacted to a dense
 * `orderIndex 0..n-1`. Without compaction, repeated archive cycles
 * would leave gaps in the index space and the next add would land at
 * `count` instead of the natural next slot.
 */
export const archiveLevel = tenantAction(async ({ tx }, input: unknown) => {
  const parsed = Input.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid level id");
  }
  const { id } = parsed.data;

  const existing = await classLevelRepository.getById(tx, id);
  if (!existing) {
    return { archived: false } as const;
  }

  await classLevelRepository.archive(tx, id);

  // Compact the surviving levels to a dense `0..n-1` index. The list is
  // already in `orderIndex asc` order, and the archived row is now
  // filtered out by `listBySchool`'s default.
  const survivors = await classLevelRepository.listBySchool(tx);
  await classLevelRepository.reorder(
    tx,
    survivors.map((l) => l.id),
  );

  revalidatePath("/s/[schoolSlug]/onboarding/levels", "page");

  return { archived: true } as const;
});
