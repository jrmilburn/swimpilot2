import { redirect } from "next/navigation";
import { OnboardingStep } from "@/domain/enums";
import { nextStepAfter } from "@/domain/onboarding";
import { markStepComplete } from "../_actions/markStepComplete";

// Chunk 1 placeholder. Chunk 5 (Sprint 4 — `skills`) replaces the body
// with the real skills form (per-level skill rubric).
//
// Note for Chunk 6: the action's Chunk-1-only short-circuit lives in
// `_actions/markStepComplete.ts` — when the next step would be `classes`,
// it sets `completed_at = NOW()` so this page redirects to the dashboard
// rather than the (not-yet-existing) `/onboarding/classes` route. Reverse
// the short-circuit there once Chunk 6 ships the classes stub.
export default async function SkillsStepPage({
  params,
}: {
  params: Promise<{ schoolSlug: string }>;
}) {
  const { schoolSlug } = await params;

  async function continueStep() {
    "use server";
    const result = await markStepComplete({ step: OnboardingStep.Skills });
    if (!result.ok) {
      throw new Error(`markStepComplete failed: ${result.error.code}`);
    }
    if (result.data.completedWizard) {
      redirect(`/s/${schoolSlug}`);
    }
    redirect(
      `/s/${schoolSlug}/onboarding/${nextStepAfter(OnboardingStep.Skills)}`,
    );
  }

  return (
    <section className="flex flex-1 flex-col items-center justify-center p-8">
      <div className="flex max-w-lg flex-col items-center gap-4 text-center">
        <h2 className="text-xl font-semibold tracking-tight">
          Step 4: Skills — coming in Chunk 5
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          The real form (per-level skill rubric) ships in Sprint 4 /
          Chunk 5. For now, click continue to advance the wizard. In Chunk 1
          this is the last visible step — clicking continue marks the
          wizard complete and bounces you to the dashboard.
        </p>
        <form action={continueStep}>
          <button
            type="submit"
            className="rounded-full bg-foreground px-5 py-2 text-sm text-background"
          >
            Continue (placeholder)
          </button>
        </form>
      </div>
    </section>
  );
}
