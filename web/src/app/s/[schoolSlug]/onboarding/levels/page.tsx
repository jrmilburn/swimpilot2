import { requireTenant } from "@/lib/auth/requireTenant";
import { withTenant } from "@/lib/db/withTenant";
import * as classLevelRepository from "@/repositories/classLevelRepository";
import { AssaDefaultPrompt } from "./_components/AssaDefaultPrompt";
import { LevelsList } from "./_components/LevelsList";
import { SamplePreview } from "./_components/SamplePreview";

// Sprint 4 / Chunk 4 — the Levels step body.
//
// Two rendering modes when the list is empty:
//   - default: render `AssaDefaultPrompt` so the operator can pre-fill
//     the four ASSA-aligned levels in one click.
//   - `?mode=scratch`: skip the prompt and open the inline editor
//     directly. Stateless query-param signal — operator can change
//     their mind by navigating away.
//
// Once one or more non-archived levels exist, the page always renders
// the standard list view.
export default async function LevelsStepPage({
  params,
  searchParams,
}: {
  params: Promise<{ schoolSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { schoolSlug } = await params;
  const sp = await searchParams;
  const mode = typeof sp.mode === "string" ? sp.mode : null;

  const { schoolId, userId } = await requireTenant(schoolSlug);

  const levels = await withTenant({ schoolId, userId }, (tx) =>
    classLevelRepository.listBySchool(tx),
  );

  const showAssaPrompt = levels.length === 0 && mode !== "scratch";

  return (
    <section className="flex flex-1 flex-col items-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h2 className="text-xl font-semibold tracking-tight">
            What levels do you teach?
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Levels group students by ability so classes pitch at the
            right pace. Add as many as you need — most schools start
            with four. You can rename, reorder, or remove any of these
            later.
          </p>
        </header>

        {showAssaPrompt ? (
          <AssaDefaultPrompt schoolSlug={schoolSlug} />
        ) : (
          <>
            <LevelsList
              initial={levels}
              schoolSlug={schoolSlug}
              forceAddOpen={mode === "scratch"}
            />
            <SamplePreview levels={levels} />
          </>
        )}
      </div>
    </section>
  );
}
