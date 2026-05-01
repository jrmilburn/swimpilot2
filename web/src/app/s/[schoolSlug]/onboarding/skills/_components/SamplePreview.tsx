import type { ClassLevel, Skill } from "@/domain/types";

// Static, server-rendered preview of how skills appear on a parent
// progression card. One mocked card titled with a placeholder student
// + the operator's first non-empty level, listing up to four skills
// with status badges.
//
// **Deliberately under-designed.** The point is to make "skill list"
// feel concrete, not to be a faithful Sprint 7 mockup. No avatar, no
// achievement timeline, no real progression-threshold calculation. If
// the markup tempts you to add one, see the Chunk 5 spec under "Flag,
// don't work around."
const STATUSES = ["Achieved", "Working on it", "Working on it", "Not started"] as const;

export function SamplePreview({
  level,
  skills,
}: {
  level: ClassLevel;
  skills: Skill[];
}) {
  // Always render: even an empty level shows the sample card with the
  // level title, so the operator gets some visual sense of the parent
  // surface. Top up with the curated empty-state copy when we have no
  // skills to show.
  const sampled = skills.slice(0, 4);

  return (
    <aside
      aria-label="Sample preview"
      className="flex flex-col gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        Preview: how skills appear on a parent progression card
      </p>

      <div className="flex flex-col gap-2 rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-950">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-semibold">Riley P.</span>
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
            {level.name}
          </span>
        </div>
        {sampled.length === 0 ? (
          <p className="text-xs text-zinc-500">
            Add skills under {level.name} and they&apos;ll show up here.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {sampled.map((skill, i) => {
              const status = STATUSES[i] ?? "Not started";
              return (
                <li
                  key={skill.id}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="truncate text-zinc-800 dark:text-zinc-200">
                    {skill.name}
                  </span>
                  <span
                    className={
                      "shrink-0 rounded-full px-2 py-0.5 text-xs " +
                      (status === "Achieved"
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200"
                        : status === "Working on it"
                          ? "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200"
                          : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300")
                    }
                  >
                    {status}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
