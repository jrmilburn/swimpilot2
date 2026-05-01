"use server";

import { z } from "zod";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import { OnboardingStep, OnboardingStepStatus } from "@/domain/enums";
import { nextStepAfter } from "@/domain/onboarding";
import * as onboardingProgressRepository from "@/repositories/onboardingProgressRepository";

// Discriminated union — same shape as `markLevelsComplete`.
//   `{ skip: true }` advances with status Skipped.
//   `{ skip: false }` advances with status Completed.
// Note: **neither path requires a minimum skill count.** The spec
// explicitly allows skipping Skills, and the save path doesn't gate on
// having skills under every level — a school can rationally have zero
// skills and still "complete" Skills (they'll add a curriculum later,
// post-onboarding). This is the difference from Levels (which gates on
// count) and Locations (no skip at all).
const Input = z.discriminatedUnion("skip", [
  z.object({ skip: z.literal(true) }),
  z.object({ skip: z.literal(false) }),
]);

/**
 * Advance the wizard from Skills to Classes. Both paths advance
 * `current_step` to the Classes stub (`/onboarding/classes`); the bridge
 * (`saveSkillsForm`) reads `completedWizard: false` and redirects to the
 * next step.
 *
 * Chunk 5 short-circuited both paths through `complete()` because the
 * `/onboarding/classes` route 404'd; Chunk 6 ships that stub and the
 * short-circuit is gone. The action returns `completedWizard: false`
 * unconditionally now — the `skipRemainingOnboarding` action on the
 * stub is the only seam that flips the wizard to "complete."
 */
export const markSkillsComplete = tenantAction(
  async ({ tx, schoolId }, input: unknown) => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Invalid input");
    }
    const { skip } = parsed.data;

    const progress = await onboardingProgressRepository.markStepStatus(tx, {
      schoolId,
      step: OnboardingStep.Skills,
      status: skip
        ? OnboardingStepStatus.Skipped
        : OnboardingStepStatus.Completed,
      nextStep: nextStepAfter(OnboardingStep.Skills),
    });

    return { ...progress, completedWizard: false } as const;
  },
);
