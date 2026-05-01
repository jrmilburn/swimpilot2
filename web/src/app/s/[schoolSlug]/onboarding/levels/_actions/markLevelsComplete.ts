"use server";

import { z } from "zod";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import { OnboardingStep, OnboardingStepStatus } from "@/domain/enums";
import { nextStepAfter } from "@/domain/onboarding";
import * as classLevelRepository from "@/repositories/classLevelRepository";
import * as onboardingProgressRepository from "@/repositories/onboardingProgressRepository";

// Discriminated union — same shape as `markProfileComplete` from Chunk 2.
// `{ skip: true }` advances with status Skipped and persists nothing.
// `{ skip: false }` requires at least one non-archived level.
const Input = z.discriminatedUnion("skip", [
  z.object({ skip: z.literal(true) }),
  z.object({ skip: z.literal(false) }),
]);

/**
 * Advance the wizard from Levels to Skills.
 *
 * Skip is allowed (per Sprint 4 spec): a school may not have a settled
 * level framework on day one. Save requires at least one non-archived
 * level — Chunk 5's Skills step needs a level to attach skills to, so
 * "saved with zero levels" would put the wizard into a broken state.
 *
 * Defence in depth (matches Locations):
 *   1. UI disables the Save button when the list is empty.
 *   2. This action queries the count inside the same `withTenant` tx
 *      and refuses with `ValidationError` if zero.
 */
export const markLevelsComplete = tenantAction(
  async ({ tx, schoolId }, input: unknown) => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Invalid input");
    }
    const { skip } = parsed.data;

    if (!skip) {
      const existing = await classLevelRepository.listBySchool(tx);
      if (existing.length === 0) {
        throw new ValidationError(
          "Add at least one level before continuing.",
          { _form: "Add at least one level before continuing." },
        );
      }
    }

    const progress = await onboardingProgressRepository.markStepStatus(tx, {
      schoolId,
      step: OnboardingStep.Levels,
      status: skip
        ? OnboardingStepStatus.Skipped
        : OnboardingStepStatus.Completed,
      nextStep: nextStepAfter(OnboardingStep.Levels),
    });

    return { ...progress, completedWizard: false } as const;
  },
);
