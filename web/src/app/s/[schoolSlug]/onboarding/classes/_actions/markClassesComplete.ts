"use server";

import { z } from "zod";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import { OnboardingStep, OnboardingStepStatus } from "@/domain/enums";
import { nextStepAfter } from "@/domain/onboarding";
import * as classRepository from "@/repositories/classRepository";
import * as onboardingProgressRepository from "@/repositories/onboardingProgressRepository";

// Discriminated union — mirrors the per-step pattern from Sprint 4.
//   `{ skip: true }`  → advance with status Skipped, no count gate.
//   `{ skip: false }` → require at least one non-archived class.
const Input = z.discriminatedUnion("skip", [
  z.object({ skip: z.literal(true) }),
  z.object({ skip: z.literal(false) }),
]);

/**
 * Advance the wizard from Classes to Teachers.
 *
 * Save path requires ≥ 1 non-archived class — the Teachers step's
 * assignment list is what makes Classes meaningful, and "saved with
 * zero classes" leaves the wizard in a state that no Sprint 5 +
 * downstream feature reads cleanly.
 *
 * Skip is allowed unconditionally: an operator who plans to bulk
 * import the schedule later still needs to clear the wizard. The
 * Teachers step takes the same shape (skip → Skipped status, save →
 * Completed status).
 *
 * Defence in depth (matches Levels):
 *   1. UI disables Continue when the list is empty.
 *   2. This action queries the count inside the same `withTenant`
 *      tx and refuses with `ValidationError` if zero.
 */
export const markClassesComplete = tenantAction(
  async ({ tx, schoolId }, input: unknown) => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Invalid input");
    }
    const { skip } = parsed.data;

    if (!skip) {
      const existing = await classRepository.listBySchool(tx, { limit: 1 });
      if (existing.items.length === 0) {
        throw new ValidationError(
          "Add at least one class before continuing.",
          { _form: "Add at least one class before continuing." },
        );
      }
    }

    const progress = await onboardingProgressRepository.markStepStatus(tx, {
      schoolId,
      step: OnboardingStep.Classes,
      status: skip
        ? OnboardingStepStatus.Skipped
        : OnboardingStepStatus.Completed,
      nextStep: nextStepAfter(OnboardingStep.Classes),
    });

    return { ...progress, completedWizard: false } as const;
  },
);
