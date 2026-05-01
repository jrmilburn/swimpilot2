"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import * as skillRepository from "@/repositories/skillRepository";

const Input = z.object({
  levelId: z.uuid("Invalid level id"),
  ids: z
    .array(z.uuid("Invalid skill id"))
    .min(1, "Reorder requires at least one id"),
});

/**
 * Wraps `skillRepository.reorder`. The accordion's per-row up/down arrows
 * fire this with the full ordered list of currently-visible skill ids
 * under one level; the repository validates the count matches the
 * tenant's non-archived row count under that level and that every id
 * belongs to the level.
 *
 * Stale-list defence: if a slow network or a parallel archive in another
 * tab leaves the client's list out of date, the repository raises
 * `ValidationError` with a friendly "please reload" message and the
 * action surfaces it as `_form`. `revalidatePath` brings the page back
 * to server truth on any error.
 */
export const reorderSkills = tenantAction(async ({ tx }, input: unknown) => {
  const parsed = Input.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(first?.message ?? "Invalid reorder list");
  }
  const { levelId, ids } = parsed.data;

  await skillRepository.reorder(tx, levelId, ids);
  revalidatePath("/s/[schoolSlug]/onboarding/skills", "page");
  return { reordered: true } as const;
});
