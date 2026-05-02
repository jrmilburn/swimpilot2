"use server";

import { z } from "zod";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import { OnboardingStep, OnboardingStepStatus } from "@/domain/enums";
import * as onboardingProgressRepository from "@/repositories/onboardingProgressRepository";
import * as importRepository from "@/repositories/importRepository";

// `skip: true` finishes the wizard without requiring an import — the
// operator can still come back and import later from the dashboard.
// `skip: false` (the Save path) requires at least one committed,
// not-yet-rolled-back batch so we never advertise the wizard as
// "complete" with zero rostered students against the operator's intent.
const Input = z.discriminatedUnion("skip", [
  z.object({ skip: z.literal(true) }),
  z.object({ skip: z.literal(false) }),
]);

export const markImportComplete = tenantAction(
  async ({ tx, schoolId }, input: unknown) => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Invalid input");
    }
    const { skip } = parsed.data;

    if (!skip) {
      const committed = await importRepository.countCommitted(tx);
      if (committed < 1) {
        throw new ValidationError(
          "Import at least one CSV before finishing — or skip this step.",
        );
      }
    }

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
