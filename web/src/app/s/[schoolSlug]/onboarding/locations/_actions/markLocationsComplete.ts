"use server";

import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import { OnboardingStep, OnboardingStepStatus } from "@/domain/enums";
import { nextStepAfter } from "@/domain/onboarding";
import * as locationRepository from "@/repositories/locationRepository";
import * as onboardingProgressRepository from "@/repositories/onboardingProgressRepository";

/**
 * Advance the wizard from Locations to Levels.
 *
 * Locations is the only step that cannot be skipped — the operator
 * must save at least one before continuing. Two layers enforce this:
 *
 *  1. UI (UX layer): the Continue button is disabled when the list is
 *     empty, and a caption explains why. That is not a security
 *     boundary — a user with devtools, a stale page, or a race
 *     condition can submit anyway.
 *  2. Server (correctness layer): this action queries the location
 *     list inside the same `withTenant` transaction. Empty list →
 *     `ValidationError`. RLS scopes the read so a foreign tenant's
 *     locations cannot inflate the count.
 *
 * No `skip` shape on the input. Skip is not a valid outcome for this
 * step; the action takes no input at all and the form bridge passes
 * nothing.
 */
export const markLocationsComplete = tenantAction(
  async ({ tx, schoolId }) => {
    const existing = await locationRepository.listBySchool(tx);
    if (existing.length === 0) {
      throw new ValidationError(
        "Add at least one location before continuing.",
        { _form: "Add at least one location before continuing." },
      );
    }

    const progress = await onboardingProgressRepository.markStepStatus(tx, {
      schoolId,
      step: OnboardingStep.Locations,
      status: OnboardingStepStatus.Completed,
      nextStep: nextStepAfter(OnboardingStep.Locations),
    });

    return { ...progress, completedWizard: false } as const;
  },
);
