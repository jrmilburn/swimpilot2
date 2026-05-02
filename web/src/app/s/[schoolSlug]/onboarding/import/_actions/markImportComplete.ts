"use server";

import { z } from "zod";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import { OnboardingStep, OnboardingStepStatus } from "@/domain/enums";
import * as onboardingProgressRepository from "@/repositories/onboardingProgressRepository";

// Both branches finish the wizard. Skip is for an operator who plans
// to import students later (or never); Continue is the same — there's
// no enrolment editor on this stub. The Sprint 6 student importer
// replaces this page; the action's contract stays the same.
const Input = z.discriminatedUnion("skip", [
  z.object({ skip: z.literal(true) }),
  z.object({ skip: z.literal(false) }),
]);

/**
 * Mark Import as completed (or skipped) AND flip the wizard's
 * `completed_at` timestamp in one transaction. This is the seam that
 * actually completes the wizard — every other step's
 * `markStepComplete` advances `current_step` but leaves
 * `completed_at` null.
 */
export const markImportComplete = tenantAction(
  async ({ tx, schoolId }, input: unknown) => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Invalid input");
    }
    const { skip } = parsed.data;

    await onboardingProgressRepository.markStepStatus(tx, {
      schoolId,
      step: OnboardingStep.Import,
      status: skip
        ? OnboardingStepStatus.Skipped
        : OnboardingStepStatus.Completed,
    });

    const completed = await onboardingProgressRepository.complete(tx, schoolId);
    return { ...completed, completedWizard: true } as const;
  },
);
