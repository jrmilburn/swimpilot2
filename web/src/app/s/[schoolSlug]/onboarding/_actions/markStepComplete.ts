"use server";

import { z } from "zod";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import { OnboardingStep, OnboardingStepStatus } from "@/domain/enums";
import {
  WIZARD_STEPS,
  isWizardStep,
  nextStepAfter,
} from "@/domain/onboarding";
import * as onboardingProgressRepository from "@/repositories/onboardingProgressRepository";

const Input = z.object({
  step: z.enum(WIZARD_STEPS),
});

/**
 * Placeholder action for Chunk 1: mark `step` as completed and advance
 * `current_step` to the next wizard step. Real per-step actions
 * (validating profile fields, locations, levels, skills) land in
 * Chunks 2–5; this generic shape exists to let us exercise the resume
 * contract end-to-end while the form bodies are still placeholders.
 *
 * **Temporary measure for Chunk 1 only.** Sprint 5's `/onboarding/classes`
 * stub does not exist yet (Chunk 6 adds it). Until then, completing the
 * Skills step would advance `current_step` to `classes` and the redirect
 * would bounce the user to a 404. We short-circuit by setting
 * `completed_at = NOW()` when the next step would be `classes`. Chunk 6
 * MUST reverse this once the stub page lands — see the Chunk 1 handoff
 * note.
 *
 * Whether to keep this as one generic action or split into per-step
 * actions in Chunks 2–5 is flagged in the handoff. The current shape is
 * fine while bodies are placeholders; once each step has real validation
 * a per-step action carrying its typed input is the more obvious fit.
 */
export const markStepComplete = tenantAction(
  async ({ tx, schoolId }, input: unknown) => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Invalid step");
    }
    const step = parsed.data.step;
    if (!isWizardStep(step)) {
      // Belt-and-braces: zod's z.enum already enforces this, but the
      // narrowing here lets the rest of the function trust the type.
      throw new ValidationError("Step is not a wizard step");
    }

    const next = nextStepAfter(step);

    // Chunk 1 short-circuit: skipping past Skills would land on `classes`
    // which has no route until Chunk 6. Mark the wizard complete so the
    // redirect bounces the user to the dashboard instead. Reverse this in
    // Chunk 6.
    if (next === OnboardingStep.Classes) {
      const result = await onboardingProgressRepository.markStepStatus(tx, {
        schoolId,
        step,
        status: OnboardingStepStatus.Completed,
      });
      await onboardingProgressRepository.complete(tx, schoolId);
      return { ...result, completedWizard: true } as const;
    }

    return {
      ...(await onboardingProgressRepository.markStepStatus(tx, {
        schoolId,
        step,
        status: OnboardingStepStatus.Completed,
        nextStep: next,
      })),
      completedWizard: false,
    } as const;
  },
);
