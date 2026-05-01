import type { ClassLevel } from "@/domain/types";

// Static, server-rendered preview of how levels appear when picking one
// for a class assignment. Disabled `<select>` plus a small read-out of
// ratio + age bounds so the operator can see the whole framework in a
// teacher's-eye view. Re-renders on every `revalidatePath` so order
// changes are reflected immediately.
//
// Deliberately under-designed: the goal is to make the abstract concept
// of "level order" feel concrete, not to be a faithful Sprint 6 mockup.
function ageRange(level: ClassLevel): string | null {
  const min = level.minAgeMonths;
  const max = level.maxAgeMonths;
  if (min == null && max == null) return null;
  const fmt = (months: number) => {
    if (months % 12 === 0) {
      const years = months / 12;
      return `${years} ${years === 1 ? "year" : "years"}`;
    }
    return `${months} months`;
  };
  if (min != null && max != null) return `ages ${fmt(min)}–${fmt(max)}`;
  if (min != null) return `ages ${fmt(min)}+`;
  return `up to ${fmt(max!)}`;
}

export function SamplePreview({ levels }: { levels: ClassLevel[] }) {
  if (levels.length === 0) return null;

  return (
    <aside
      aria-label="Sample preview"
      className="flex flex-col gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        Preview: how levels appear when assigning a class
      </p>

      <label className="flex flex-col gap-1 text-sm">
        <span>Class level</span>
        <select
          disabled
          aria-disabled
          defaultValue={levels[0]?.id}
          className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
        >
          {levels.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>

      <ul className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
        {levels.map((l) => {
          const range = ageRange(l);
          return (
            <li key={l.id}>
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                {l.name}
              </span>
              {" — ratio 1:"}
              {l.ratio}
              {range ? `, ${range}` : ""}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
