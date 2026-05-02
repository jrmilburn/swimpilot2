"use server";

import { z } from "zod";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import { OnboardingStep, OnboardingStepStatus } from "@/domain/enums";
import { nextStepAfter } from "@/domain/onboarding";
import * as onboardingProgressRepository from "@/repositories/onboardingProgressRepository";

// Discriminated union — Teachers is fully optional. Both branches
// advance the wizard; neither requires a count gate.
//
// Why no gate even on save: a single-owner school, a school with bulk-
// import-later plans, and a school that hasn't found its first hire
// all rationally complete the Teachers step with zero teachers and
// zero invitations. Forcing one would be theatre.
const Input = z.discriminatedUnion("skip", [
  z.object({ skip: z.literal(true) }),
  z.object({ skip: z.literal(false) }),
]);

/**
 * Advance the wizard from Teachers to Import. Both paths advance
 * `current_step` to Import (the next entry in
 * `ONBOARDING_STEP_ORDER`). The Import stub is the seam that flips
 * `completed_at` on the wizard.
 */
export const markTeachersComplete = tenantAction(
  async ({ tx, schoolId }, input: unknown) => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Invalid input");
    }
    const { skip } = parsed.data;

    const progress = await onboardingProgressRepository.markStepStatus(tx, {
      schoolId,
      step: OnboardingStep.Teachers,
      status: skip
        ? OnboardingStepStatus.Skipped
        : OnboardingStepStatus.Completed,
      nextStep: nextStepAfter(OnboardingStep.Teachers),
    });

    return { ...progress, completedWizard: false } as const;
  },
);
