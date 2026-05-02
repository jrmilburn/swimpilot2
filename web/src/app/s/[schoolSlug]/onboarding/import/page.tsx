import { requireTenant } from "@/lib/auth/requireTenant";
import { ImportWorkspace } from "./_components/ImportWorkspace";

/**
 * Sprint 5 / Chunk 2 — the Import step's CSV importer.
 *
 * The page is intentionally a thin server-component shell. The
 * interactive workspace is a client component because the four
 * intents (parse / dry-run / commit / rollback) compose iteratively
 * — the operator picks a CSV, edits the mapping, dry-runs, applies
 * resolutions to findings, dry-runs again, and only then commits.
 *
 * Mapping state lives in the workspace via lifted-up React state, not
 * inside `MappingPanel`, so the AI suggestions panel that lands in
 * Chunk 3 can call `setMapping` from outside without coordinating
 * through internal component state.
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
      <div className="flex w-full max-w-5xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h2 className="text-xl font-semibold tracking-tight">
            Import your students
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Upload a CSV of your existing roster. We&apos;ll preview a
            handful of rows, let you map your columns to ours, dry-run
            for problems, and only commit once you&apos;re happy. You
            can roll any committed batch back from this page.
          </p>
        </header>

        <ImportWorkspace schoolSlug={schoolSlug} />
      </div>
    </section>
  );
}
