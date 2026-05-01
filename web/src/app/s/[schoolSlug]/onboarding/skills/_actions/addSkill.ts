"use server";

import { revalidatePath } from "next/cache";
import { tenantAction } from "@/lib/auth/tenantAction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import * as classLevelRepository from "@/repositories/classLevelRepository";
import * as skillRepository from "@/repositories/skillRepository";
import { CreateSkillSchema } from "./skillFields";

/**
 * Create a single skill under one level for the current tenant.
 * `orderIndex` is computed server-side: append at the end of the live
 * non-archived list under `levelId`. The form never submits an index.
 *
 * Cross-tenant `levelId` defence: read `classLevelRepository.getById`
 * first. RLS hides foreign rows, so the read returns null and we throw
 * `NotFoundError` before attempting the write. The
 * `skills_consistency` trigger is the second line of defence — it would
 * raise `check_violation` on a mismatched `(school_id, level_id)` pair —
 * but pre-checking surfaces a typed error rather than letting a Postgres
 * code leak to the client. Documented decision: this is "level not in
 * your school" surfaced as NOT_FOUND rather than VALIDATION.
 *
 * Per-row actions are deliberately separate from `markSkillsComplete`,
 * matching the Locations / Levels per-row pattern.
 */
export const addSkill = tenantAction(async ({ tx }, input: unknown) => {
  const parsed = CreateSkillSchema.safeParse(input);
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
  const data = parsed.data;

  const level = await classLevelRepository.getById(tx, data.levelId);
  if (!level) {
    throw new NotFoundError("Level not found");
  }

  // Snapshot the live non-archived count under this level to compute the
  // new index. RLS scopes the read to the current tenant.
  const existing = await skillRepository.listByLevel(tx, data.levelId);
  const orderIndex = existing.length;

  // Name uniqueness conflicts (Prisma `P2002` on the
  // `(school_id, level_id, name)` index) are mapped to a typed
  // `ValidationError` keyed against `name` inside the repository.
  const created = await skillRepository.create(tx, {
    levelId: data.levelId,
    name: data.name,
    description: data.description,
    orderIndex,
  });

  revalidatePath("/s/[schoolSlug]/onboarding/skills", "page");
  return created;
});
