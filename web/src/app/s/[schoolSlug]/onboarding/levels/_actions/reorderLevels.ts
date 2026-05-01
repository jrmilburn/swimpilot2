"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import * as classLevelRepository from "@/repositories/classLevelRepository";

const Input = z.object({
  ids: z
    .array(z.uuid("Invalid level id"))
    .min(1, "Reorder requires at least one id"),
});

/**
 * Wraps `classLevelRepository.reorder`. The UI sends the full ordered
 * list of currently-visible level ids whenever the operator clicks an
 * up/down arrow; the repository validates the count matches the tenant's
 * non-archived row count and that every id belongs to the tenant.
 *
 * Stale-list defence: if a slow network or a parallel archive in another
 * tab leaves the client's list out of date, the repository raises
 * `ValidationError` with a friendly "please reload" message and the
 * action surfaces it as `_form`. Don't try to merge or reconcile —
 * `revalidatePath` brings the page back to server truth on any error.
 */
export const reorderLevels = tenantAction(
  async ({ tx }, input: unknown) => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ValidationError(first?.message ?? "Invalid reorder list");
    }
    const { ids } = parsed.data;

    await classLevelRepository.reorder(tx, ids);
    revalidatePath("/s/[schoolSlug]/onboarding/levels", "page");
    return { reordered: true } as const;
  },
);
