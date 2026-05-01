"use server";

import { tenantAction } from "@/lib/auth/tenantAction";
import * as onboardingProgressRepository from "@/repositories/onboardingProgressRepository";

/**
 * Sprint 5 escape hatch on the `/onboarding/classes` stub. Marks the
 * onboarding row complete (`completed_at = now()`, `current_step = done`)
 * so the operator can finish onboarding before the real classes step
 * lands. The form bridge on the stub redirects to `/s/<slug>` directly;
 * the action returns `completedWizard: true` for symmetry with the
 * per-step actions.
 *
 * No input — the affordance is a single button. Idempotent: re-running
 * against an already-complete row is a no-op (`complete()` handles the
 * second call).
 *
 * Sprint 5 will replace the stub page with a real classes step. At that
 * point this action either gets removed (the real step has its own
 * `markClassesComplete`) or kept as a generic exit affordance — call
 * flagged in the Chunk 6 handoff.
 */
export const skipRemainingOnboarding = tenantAction(
  async ({ tx, schoolId }) => {
    const progress = await onboardingProgressRepository.complete(tx, schoolId);
    return { ...progress, completedWizard: true } as const;
  },
);
