"use server";

import { revalidatePath } from "next/cache";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import * as classLevelRepository from "@/repositories/classLevelRepository";
import { CreateLevelSchema } from "./levelFields";

/**
 * Create a single class level for the current tenant. `orderIndex` is
 * computed server-side: append at the end of the current non-archived
 * list. The form never submits an index — see `levelFields.ts` for the
 * rationale.
 *
 * Per-row actions are deliberately separate from `markLevelsComplete`,
 * matching the Locations chunk-3 pattern: per-row mutations call their
 * own action + `revalidatePath`; Continue runs through `useActionState`.
 */
export const addLevel = tenantAction(async ({ tx }, input: unknown) => {
  const parsed = CreateLevelSchema.safeParse(input);
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
  const data = parsed.data;

  // Snapshot the current non-archived count to compute the new index.
  // RLS scopes the read to the current tenant.
  const existing = await classLevelRepository.listBySchool(tx);
  const orderIndex = existing.length;

  // Name uniqueness conflicts (Prisma `P2002` on the
  // `(school_id, name)` index) are mapped to a typed
  // `ValidationError` inside the repository, so the action layer
  // doesn't need to import Prisma to surface the right field error.
  const created = await classLevelRepository.create(tx, {
    name: data.name,
    description: data.description,
    ratio: data.ratio,
    orderIndex,
    minAgeMonths: data.minAgeMonths,
    maxAgeMonths: data.maxAgeMonths,
    defaultProgressionThreshold: data.defaultProgressionThreshold,
  });

  revalidatePath("/s/[schoolSlug]/onboarding/levels", "page");
  return created;
});
