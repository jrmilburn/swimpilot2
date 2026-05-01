"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { tenantAction } from "@/lib/auth/tenantAction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import {
  ASSA_SKILL_TEMPLATE,
  hasAssaSkillTemplate,
} from "@/domain/assaSkillTemplate";
import * as classLevelRepository from "@/repositories/classLevelRepository";
import * as skillRepository from "@/repositories/skillRepository";

const Input = z.object({ levelId: z.uuid("Invalid level id") });

/**
 * Pre-fill the curated ASSA skill set under one level. The lookup is by
 * the level's `orderIndex` (0..3) — see
 * `docs/architecture.md` → "Onboarding templates" for the position-not-
 * name contract.
 *
 * Refuses with a typed `_form` validation error when:
 *   - The level is at `orderIndex >= 4` (a custom level the operator
 *     added beyond the four ASSA defaults; no template covers it).
 *   - The level already has any non-archived skill (concurrent double-
 *     click guard via the `(school_id, level_id, name)` unique index;
 *     this pre-check makes the failure mode explicit).
 *
 * Cross-tenant `levelId` returns NOT_FOUND — RLS hides the row from
 * `getById` so the read returns null. Same shape as `addSkill`.
 *
 * Concurrent double-click: same shape as `applyAssaDefaults` (Chunk 4).
 * The unique index is the lock; on the second insert the repository's
 * `mapUniqueViolation` throws and we re-key the resulting field error
 * to `_form` with a friendly message.
 */
export const applyAssaSkillsForLevel = tenantAction(
  async ({ tx }, input: unknown) => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Invalid level id");
    }
    const { levelId } = parsed.data;

    const level = await classLevelRepository.getById(tx, levelId);
    if (!level) {
      throw new NotFoundError("Level not found");
    }

    if (!hasAssaSkillTemplate(level.orderIndex)) {
      throw new ValidationError(
        "No default skills template for this level — add skills manually.",
        {
          _form:
            "No default skills template for this level — add skills manually.",
        },
      );
    }

    const existing = await skillRepository.listByLevel(tx, levelId);
    if (existing.length > 0) {
      throw new ValidationError(
        "Couldn't apply defaults — this level already has skills.",
        {
          _form:
            "Couldn't apply defaults — this level already has skills.",
        },
      );
    }

    const template = ASSA_SKILL_TEMPLATE[level.orderIndex];

    try {
      for (let i = 0; i < template.length; i++) {
        const entry = template[i]!;
        await skillRepository.create(tx, {
          levelId,
          name: entry.name,
          description: entry.description ?? null,
          orderIndex: i,
        });
      }
    } catch (err) {
      // The repository maps Prisma `P2002` to a `ValidationError` keyed
      // against `name`. The only path that reaches this after the count
      // pre-check above is a concurrent double-click, so re-key to
      // `_form` for the prompt-level UX surface.
      if (err instanceof ValidationError) {
        throw new ValidationError(
          "Couldn't apply defaults — please try again.",
          { _form: "Couldn't apply defaults — please try again." },
        );
      }
      throw err;
    }

    revalidatePath("/s/[schoolSlug]/onboarding/skills", "page");

    return { applied: template.length } as const;
  },
);
