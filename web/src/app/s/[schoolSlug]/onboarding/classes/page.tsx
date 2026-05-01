import { ComingSoonCard } from "./_components/ComingSoonCard";

// Sprint 4 / Chunk 6 — placeholder for the Sprint 5 Classes step.
//
// Renders inside the existing wizard chrome (the parent `layout.tsx`
// reads `onboarding_progress` and mounts the progress indicator). The
// only deliverables here are:
//   - explain to the operator that Classes is mid-flight,
//   - offer "Back to Skills" so they can revisit the previous step,
//   - offer "Skip the rest of onboarding for now" so they can finish
//     onboarding before Sprint 5 ships.
//
// Sprint 5 replaces this page with the real classes step. The
// `skipRemainingOnboarding` action lives in `_actions/` so Sprint 5 can
// either delete it (replaced by `markClassesComplete`) or keep it as a
// generic exit affordance.
export default async function ClassesStubPage({
  params,
}: {
  params: Promise<{ schoolSlug: string }>;
}) {
  const { schoolSlug } = await params;

  return (
    <section className="flex flex-1 flex-col items-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h2 className="text-xl font-semibold tracking-tight">
            Set up your classes
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            This is where you&apos;ll define the recurring class slots
            students enrol into. The full editor is coming in the next
            release.
          </p>
        </header>

        <ComingSoonCard schoolSlug={schoolSlug} />
      </div>
    </section>
  );
}
