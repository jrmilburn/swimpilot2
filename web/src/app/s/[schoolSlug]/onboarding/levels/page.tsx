import { redirect } from "next/navigation";
import { OnboardingStep } from "@/domain/enums";
import { nextStepAfter } from "@/domain/onboarding";
import { markStepComplete } from "../_actions/markStepComplete";

// Chunk 1 placeholder. Chunk 4 (Sprint 4 — `levels`) replaces the body
// with the real levels form (level catalogue, ordering, prerequisites).
export default async function LevelsStepPage({
  params,
}: {
  params: Promise<{ schoolSlug: string }>;
}) {
  const { schoolSlug } = await params;

  async function continueStep() {
    "use server";
    const result = await markStepComplete({ step: OnboardingStep.Levels });
    if (!result.ok) {
      throw new Error(`markStepComplete failed: ${result.error.code}`);
    }
    if (result.data.completedWizard) {
      redirect(`/s/${schoolSlug}`);
    }
    redirect(
      `/s/${schoolSlug}/onboarding/${nextStepAfter(OnboardingStep.Levels)}`,
    );
  }

  return (
    <section className="flex flex-1 flex-col items-center justify-center p-8">
      <div className="flex max-w-lg flex-col items-center gap-4 text-center">
        <h2 className="text-xl font-semibold tracking-tight">
          Step 3: Levels — coming in Chunk 4
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          The real form (level catalogue with ordering and prerequisites)
          ships in Sprint 4 / Chunk 4. For now, click continue to advance
          the wizard.
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
