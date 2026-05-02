import { requireTenant } from "@/lib/auth/requireTenant";
import { ContinueControls } from "./_components/ContinueControls";

/**
 * Sprint 5 / Chunk 1 — the Import stub.
 *
 * The student importer ships in Sprint 6. Until then this page exists
 * solely to terminate the wizard: both Continue and Skip dispatch
 * `markImportComplete`, which flips `completed_at` on the wizard's
 * progress row and redirects to the school dashboard.
 *
 * The page intentionally does no data fetching — there's nothing to
 * show — and reads as a "you're done" handoff rather than a real
 * editor. When Sprint 6 lands, the importer UI replaces this body but
 * the action's contract (and the redirect target on success) stays
 * the same.
 */
export default async function ImportStepPage({
  params,
}: {
  params: Promise<{ schoolSlug: string }>;
}) {
  const { schoolSlug } = await params;
  await requireTenant(schoolSlug);

  return (
    <section className="flex flex-1 flex-col items-center px-6 py-10">
      <div className="flex w-full max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h2 className="text-xl font-semibold tracking-tight">
            Import your students
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            The student importer is shipping in the next release. For
            now, you can finish setup without it — your school is ready
            to use as soon as you click below. You&apos;ll be able to
            import your roster (or add students manually) from the
            dashboard once it&apos;s available.
          </p>
        </header>

        <div className="rounded-md border border-zinc-200 bg-white p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
          <p className="mb-1 font-medium text-zinc-900 dark:text-zinc-100">
            What happens when you finish?
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Your wizard is marked complete.</li>
            <li>You land on your school dashboard.</li>
            <li>
              Teachers you invited keep getting their invite emails — no
              re-send needed.
            </li>
          </ul>
        </div>

        <ContinueControls schoolSlug={schoolSlug} />
      </div>
    </section>
  );
}
