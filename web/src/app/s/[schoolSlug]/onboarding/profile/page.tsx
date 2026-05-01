import { redirect } from "next/navigation";
import { OnboardingStep } from "@/domain/enums";
import { nextStepAfter } from "@/domain/onboarding";
import { markStepComplete } from "../_actions/markStepComplete";

// Chunk 1 placeholder. Chunk 2 (Sprint 4 — `profile`) replaces the body
// with the real school-profile form (display name, contact email, phone,
// time zone, currency). The `<form action>` shape stays — only the inputs
// inside the form change.
export default async function ProfileStepPage({
  params,
}: {
  params: Promise<{ schoolSlug: string }>;
}) {
  const { schoolSlug } = await params;

  async function continueStep() {
    "use server";
    const result = await markStepComplete({ step: OnboardingStep.Profile });
    if (!result.ok) {
      // Chunk 1 has no validation-failure paths — the placeholder always
      // succeeds. Errors here mean the wrapper itself failed (auth, RLS,
      // DB outage); surface as a thrown error so the framework error
      // boundary catches it. Chunks 2–5 swap this for `useActionState`
      // once forms have real validation.
      throw new Error(`markStepComplete failed: ${result.error.code}`);
    }
    if (result.data.completedWizard) {
      redirect(`/s/${schoolSlug}`);
    }
    redirect(
      `/s/${schoolSlug}/onboarding/${nextStepAfter(OnboardingStep.Profile)}`,
    );
  }

  return (
    <section className="flex flex-1 flex-col items-center justify-center p-8">
      <div className="flex max-w-lg flex-col items-center gap-4 text-center">
        <h2 className="text-xl font-semibold tracking-tight">
          Step 1: Profile — coming in Chunk 2
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          The real form (display name, contact email, time zone, currency)
          ships in Sprint 4 / Chunk 2. For now, click continue to advance
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
