"use server";

import { revalidatePath } from "next/cache";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import { ASSA_LEVEL_TEMPLATE } from "@/domain/assaLevelTemplate";
import * as classLevelRepository from "@/repositories/classLevelRepository";

/**
 * Pre-fill the four ASSA-aligned default levels for a school that has
 * none. Refuses if any non-archived level already exists — letting
 * "apply defaults" merge with operator-edited rows opens thorny
 * questions about ordering and name collisions, and the UX path that
 * reaches this action only renders the prompt when the list is empty.
 *
 * Position 0..3 of the inserted rows is the contract Chunk 5's skill
 * template will key off. The operator can rename "Beginner" to
 * "Tadpoles" later and the lookup still works because Chunk 5 looks up
 * by `orderIndex`, not by name. See `docs/architecture.md` →
 * "Onboarding templates".
 *
 * Concurrent double-click defence: the unique index on
 * `(school_id, name)` makes the second concurrent insert error out;
 * we map the Prisma `P2002` to a friendly `_form` validation message
 * rather than letting the raw error surface.
 */
export const applyAssaDefaults = tenantAction(async ({ tx }) => {
  const existing = await classLevelRepository.listBySchool(tx);
  if (existing.length > 0) {
    throw new ValidationError(
      "Defaults can only be applied when no levels exist yet.",
      {
        _form: "Defaults can only be applied when no levels exist yet.",
      },
    );
  }

  try {
    for (let i = 0; i < ASSA_LEVEL_TEMPLATE.length; i++) {
      const entry = ASSA_LEVEL_TEMPLATE[i]!;
      await classLevelRepository.create(tx, {
        name: entry.name,
        ratio: entry.ratio,
        orderIndex: i,
        defaultProgressionThreshold: entry.defaultProgressionThreshold,
        minAgeMonths: entry.minAgeMonths,
        maxAgeMonths: entry.maxAgeMonths,
      });
    }
  } catch (err) {
    // The repository maps Prisma `P2002` (the `(school_id, name)`
    // unique index) to a `ValidationError` keyed against `name`.
    // Concurrent double-click is the only path that reaches this after
    // the count pre-check above, so re-key as a `_form` message that
    // matches what the prompt UI renders.
    if (err instanceof ValidationError) {
      throw new ValidationError(
        "Couldn't apply defaults — please try again.",
        { _form: "Couldn't apply defaults — please try again." },
      );
    }
    throw err;
  }

  revalidatePath("/s/[schoolSlug]/onboarding/levels", "page");

  return { applied: ASSA_LEVEL_TEMPLATE.length } as const;
});
