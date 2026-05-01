"use server";

import { z } from "zod";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import { OnboardingStep, OnboardingStepStatus } from "@/domain/enums";
import { nextStepAfter } from "@/domain/onboarding";
import * as onboardingProgressRepository from "@/repositories/onboardingProgressRepository";
import * as schoolRepository from "@/repositories/schoolRepository";

// ABN validation: length-only this chunk. We strip whitespace and check
// for exactly 11 digits — no checksum (modulus-89, weighted digits).
// The full check is a real algorithm with tiny implementations on npm
// but the Sprint 4 spec calls it polish: an invalid ABN is a
// self-correction issue, not a security one. Adding it later is a
// single line in this schema with no migration impact.
const ABN_REGEX = /^\d{11}$/;

function normaliseAbn(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const stripped = value.replace(/\s+/g, "");
  return stripped === "" ? null : stripped;
}

const ProfileFields = z.object({
  legalName: z.string().min(1).max(200).nullable(),
  tradingName: z.string().min(1).max(200).nullable(),
  abn: z
    .string()
    .nullable()
    .transform((v) => normaliseAbn(v))
    .refine((v) => v === null || ABN_REGEX.test(v), {
      message: "ABN must be 11 digits",
    }),
  gstRegistered: z.boolean(),
  primaryContactName: z.string().min(1).max(200).nullable(),
  primaryContactEmail: z
    .string()
    .nullable()
    .refine(
      (v) => v === null || z.email().safeParse(v).success,
      { message: "Primary contact email is invalid" },
    ),
  primaryContactPhone: z.string().min(1).max(50).nullable(),
  logoUrl: z.string().min(1).max(500).nullable(),
});

const Input = z.discriminatedUnion("skip", [
  z.object({ skip: z.literal(true) }),
  z.object({ skip: z.literal(false) }).extend(ProfileFields.shape),
]);

export type MarkProfileCompleteInput = z.infer<typeof Input>;

/**
 * Mark the Profile step finished and advance the wizard.
 *
 * Two shapes:
 *   - `{ skip: true }` — the user clicked Skip. No fields persisted; the
 *     step status flips to `skipped`. `current_step` advances to
 *     Locations.
 *   - `{ skip: false, ...profileFields }` — Save. Field values land on
 *     `schools` via `schoolRepository.update`; the step status flips to
 *     `completed` (or stays `completed` — see below); `current_step`
 *     advances to Locations.
 *
 * Skipped → Completed on save (decision flagged in the chunk handoff):
 * if a step was previously skipped and the user re-enters it via the
 * progress indicator and saves real data, the status moves to
 * `completed`. The user has explicitly committed values — preserving
 * "skipped" would misrepresent the state.
 *
 * Return shape matches the Chunk 1 generic action so the page-level
 * redirect handler doesn't change: `{ ...progress, completedWizard }`.
 * `completedWizard` is always false here — Profile is the first wizard
 * step, no short-circuit possible.
 */
export const markProfileComplete = tenantAction(
  async ({ tx, schoolId }, input: unknown) => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ValidationError(first?.message ?? "Invalid profile input");
    }
    const data = parsed.data;

    if (!data.skip) {
      await schoolRepository.update(tx, schoolId, {
        legalName: data.legalName,
        tradingName: data.tradingName,
        abn: data.abn,
        gstRegistered: data.gstRegistered,
        primaryContactName: data.primaryContactName,
        primaryContactEmail: data.primaryContactEmail,
        primaryContactPhone: data.primaryContactPhone,
        logoUrl: data.logoUrl,
      });
    }

    const status = data.skip
      ? OnboardingStepStatus.Skipped
      : OnboardingStepStatus.Completed;

    const progress = await onboardingProgressRepository.markStepStatus(tx, {
      schoolId,
      step: OnboardingStep.Profile,
      status,
      nextStep: nextStepAfter(OnboardingStep.Profile),
    });

    return { ...progress, completedWizard: false } as const;
  },
);
