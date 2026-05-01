import { redirect } from "next/navigation";
import { OnboardingStep } from "@/domain/enums";
import { nextStepAfter } from "@/domain/onboarding";
import { markStepComplete } from "../_actions/markStepComplete";

// Chunk 1 placeholder. Chunk 3 (Sprint 4 — `locations`) replaces the body
// with the real locations form (pool / venue list, address, capacity).
export default async function LocationsStepPage({
  params,
}: {
  params: Promise<{ schoolSlug: string }>;
}) {
  const { schoolSlug } = await params;

  async function continueStep() {
    "use server";
    const result = await markStepComplete({ step: OnboardingStep.Locations });
    if (!result.ok) {
      throw new Error(`markStepComplete failed: ${result.error.code}`);
    }
    if (result.data.completedWizard) {
      redirect(`/s/${schoolSlug}`);
    }
    redirect(
      `/s/${schoolSlug}/onboarding/${nextStepAfter(OnboardingStep.Locations)}`,
    );
  }

  return (
    <section className="flex flex-1 flex-col items-center justify-center p-8">
      <div className="flex max-w-lg flex-col items-center gap-4 text-center">
        <h2 className="text-xl font-semibold tracking-tight">
          Step 2: Locations — coming in Chunk 3
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          The real form (pool / venue list with address and capacity) ships
          in Sprint 4 / Chunk 3. For now, click continue to advance the
          wizard.
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
