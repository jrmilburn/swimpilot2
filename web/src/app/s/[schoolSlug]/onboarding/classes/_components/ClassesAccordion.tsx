import type { Class, ClassLevel, Location } from "@/domain/types";
import { ClassesList } from "./ClassesList";

/**
 * Outer accordion for the Classes step. One `<details>` section per
 * level — same shape as `SkillsAccordion`. The first level is open by
 * default; native `<details>`/`<summary>` keeps it client-state-free.
 *
 * Per-level summary surfaces the class count so the operator can see at
 * a glance which levels still need a class without opening every
 * section.
 */
export function ClassesAccordion({
  levels,
  classesByLevel,
  locations,
}: {
  levels: ClassLevel[];
  classesByLevel: Record<string, Class[]>;
  locations: Location[];
}) {
  return (
    <div className="flex flex-col gap-3">
      {levels.map((level, index) => {
        const classes = classesByLevel[level.id] ?? [];
        return (
          <details
            key={level.id}
            open={index === 0}
            className="rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
          >
            <summary className="flex cursor-pointer items-baseline justify-between gap-2 px-4 py-3 text-sm font-medium">
              <span>{level.name}</span>
              <span className="text-xs text-zinc-500">
                {classes.length} class{classes.length === 1 ? "" : "es"} ·
                ratio {level.ratio}
              </span>
            </summary>
            <div className="flex flex-col gap-3 border-t border-zinc-200 px-4 py-4 dark:border-zinc-800">
              <ClassesList
                initial={classes}
                levelId={level.id}
                levelRatio={level.ratio}
                locations={locations}
              />
            </div>
          </details>
        );
      })}
    </div>
  );
}
