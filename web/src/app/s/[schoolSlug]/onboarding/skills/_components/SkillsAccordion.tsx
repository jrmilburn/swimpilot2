import type { ClassLevel, Skill } from "@/domain/types";
import { hasAssaSkillTemplate } from "@/domain/assaSkillTemplate";
import { SkillsList } from "./SkillsList";
import { AssaSkillsPrompt } from "./AssaSkillsPrompt";

/**
 * Outer accordion for the Skills step. One collapsible `<details>`
 * section per level. Native HTML — no client state, no library, matches
 * the up/down-arrows-not-DnD spirit of Chunk 4.
 *
 * Default open behaviour: the first level is expanded; others
 * collapsed. Operator can click any `<summary>` to toggle.
 *
 * Per-level prompt rendering rules:
 *   - level has skills → render the inline list (no prompt).
 *   - level is empty AND `?mode=scratch` is in effect → render the
 *     `SkillsList` directly with the inline editor open.
 *   - level is empty AND has a template (orderIndex 0..3) → render
 *     `AssaSkillsPrompt`.
 *   - level is empty AND has no template (orderIndex 4+) → render a
 *     "no default template" hint above the inline editor.
 *
 * The component itself is a server component. The list / prompt
 * children own the client behaviour where they need it.
 */
export function SkillsAccordion({
  levels,
  skillsByLevel,
  schoolSlug,
  hideAllPrompts,
}: {
  levels: ClassLevel[];
  skillsByLevel: Record<string, Skill[]>;
  schoolSlug: string;
  hideAllPrompts: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      {levels.map((level, index) => {
        const skills = skillsByLevel[level.id] ?? [];
        const isEmpty = skills.length === 0;
        const showAssaPrompt =
          isEmpty &&
          !hideAllPrompts &&
          hasAssaSkillTemplate(level.orderIndex);
        const showNoTemplateHint =
          isEmpty && !hasAssaSkillTemplate(level.orderIndex);

        return (
          <details
            key={level.id}
            // Use a stable key (the level id) on the details so the
            // browser preserves open/closed state across re-renders.
            open={index === 0}
            className="rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
          >
            <summary className="flex cursor-pointer items-baseline justify-between gap-2 px-4 py-3 text-sm font-medium">
              <span>{level.name}</span>
              <span className="text-xs text-zinc-500">
                {skills.length} skill{skills.length === 1 ? "" : "s"}
              </span>
            </summary>
            <div className="flex flex-col gap-3 border-t border-zinc-200 px-4 py-4 dark:border-zinc-800">
              {showAssaPrompt ? (
                <AssaSkillsPrompt
                  schoolSlug={schoolSlug}
                  levelId={level.id}
                  levelName={level.name}
                />
              ) : null}
              {showNoTemplateHint ? (
                <p className="text-xs text-zinc-500">
                  No default skills template for {level.name} — add the
                  skills you want students to work on.
                </p>
              ) : null}
              {showAssaPrompt ? null : (
                <SkillsList
                  initial={skills}
                  levelId={level.id}
                  forceAddOpen={isEmpty && hideAllPrompts}
                />
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}
