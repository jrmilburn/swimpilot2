import { requireTenant } from "@/lib/auth/requireTenant";
import { withTenant } from "@/lib/db/withTenant";
import * as classLevelRepository from "@/repositories/classLevelRepository";
import * as skillRepository from "@/repositories/skillRepository";
import { SkillsAccordion } from "./_components/SkillsAccordion";
import { SkillsBlockedByLevels } from "./_components/SkillsBlockedByLevels";
import { SamplePreview } from "./_components/SamplePreview";
import { ContinueControls } from "./_components/ContinueControls";

// Sprint 4 / Chunk 5 — the Skills step body.
//
// Three rendering branches:
//   1. Zero levels: render `SkillsBlockedByLevels`. Save is hidden;
//      Skip is wired so the operator isn't trapped.
//   2. One+ levels: render the accordion (one section per level). Per-
//      level "Use ASSA defaults" prompt only surfaces when that level
//      has zero skills AND is at orderIndex 0..3 (positions covered by
//      `ASSA_SKILL_TEMPLATE`). Levels at position 4+ get a "no default
//      template" hint instead.
//
// Single `?mode=scratch` query param suppresses *all* per-level ASSA
// prompts at once — chosen over a per-level scratch list because an
// operator who clicks "Start from scratch" probably wants to control
// all of them and the per-level state would just add bookkeeping.
// Documented decision in the handoff.
export default async function SkillsStepPage({
  params,
  searchParams,
}: {
  params: Promise<{ schoolSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { schoolSlug } = await params;
  const sp = await searchParams;
  const mode = typeof sp.mode === "string" ? sp.mode : null;
  const hideAllPrompts = mode === "scratch";

  const { schoolId, userId } = await requireTenant(schoolSlug);

  const { levels, skillsByLevel } = await withTenant(
    { schoolId, userId },
    async (tx) => {
      const levels = await classLevelRepository.listBySchool(tx);
      // Sequential reads — the level list is small (≤ ~10) so the
      // round-trips don't add up. RLS scopes everything inside the same
      // tx so per-level reads share the connection.
      const skillsByLevel: Record<string, Awaited<
        ReturnType<typeof skillRepository.listByLevel>
      >> = {};
      for (const level of levels) {
        skillsByLevel[level.id] = await skillRepository.listByLevel(
          tx,
          level.id,
        );
      }
      return { levels, skillsByLevel };
    },
  );

  if (levels.length === 0) {
    return (
      <section className="flex flex-1 flex-col items-center px-6 py-10">
        <div className="flex w-full max-w-2xl flex-col gap-6">
          <header className="flex flex-col gap-2">
            <h2 className="text-xl font-semibold tracking-tight">
              Build your skill curriculum
            </h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Skills are what students work on inside each level. They
              show up on the parent progression cards and on teacher
              attendance sheets.
            </p>
          </header>

          <SkillsBlockedByLevels schoolSlug={schoolSlug} />
        </div>
      </section>
    );
  }

  const firstNonEmpty = levels.find(
    (l) => (skillsByLevel[l.id] ?? []).length > 0,
  );
  const previewLevel = firstNonEmpty ?? levels[0]!;
  const previewSkills = skillsByLevel[previewLevel.id] ?? [];

  return (
    <section className="flex flex-1 flex-col items-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h2 className="text-xl font-semibold tracking-tight">
            Build your skill curriculum
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Add a few skills under each level. Most schools start with
            five to eight per level — you can refine the list later.
          </p>
        </header>

        <SkillsAccordion
          levels={levels}
          skillsByLevel={skillsByLevel}
          schoolSlug={schoolSlug}
          hideAllPrompts={hideAllPrompts}
        />

        <SamplePreview level={previewLevel} skills={previewSkills} />

        <ContinueControls schoolSlug={schoolSlug} />
      </div>
    </section>
  );
}
