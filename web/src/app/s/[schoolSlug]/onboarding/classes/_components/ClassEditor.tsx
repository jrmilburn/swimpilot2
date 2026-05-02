"use client";

import type { Class, Location } from "@/domain/types";
import { WeekDay } from "@/domain/enums";

export type ClassDraft = {
  locationId: string;
  dayOfWeek: string;
  startTime: string;
  durationMinutes: string;
  capacity: string;
};

export const emptyClassDraft = (defaults?: {
  locationId?: string;
  capacity?: number;
}): ClassDraft => ({
  locationId: defaults?.locationId ?? "",
  dayOfWeek: WeekDay.Monday,
  startTime: "16:00",
  durationMinutes: "30",
  capacity: defaults?.capacity != null ? String(defaults.capacity) : "4",
});

export const draftFromClass = (cls: Class): ClassDraft => ({
  locationId: cls.locationId,
  dayOfWeek: cls.dayOfWeek,
  // The repository hands back HH:MM:SS; the form input is HH:MM. Strip
  // seconds so the round-trip doesn't show "16:00:00" in a five-char box.
  startTime: cls.startTime.slice(0, 5),
  durationMinutes: String(cls.durationMinutes),
  capacity: String(cls.capacity),
});

const FIELD_LABEL: React.CSSProperties = { fontWeight: 500 };

const WEEK_DAYS = [
  { value: WeekDay.Monday, label: "Monday" },
  { value: WeekDay.Tuesday, label: "Tuesday" },
  { value: WeekDay.Wednesday, label: "Wednesday" },
  { value: WeekDay.Thursday, label: "Thursday" },
  { value: WeekDay.Friday, label: "Friday" },
  { value: WeekDay.Saturday, label: "Saturday" },
  { value: WeekDay.Sunday, label: "Sunday" },
];

// 15..120 in 5-minute steps. Same set the action's zod schema enforces.
const DURATION_OPTIONS = (() => {
  const out: number[] = [];
  for (let m = 15; m <= 120; m += 5) out.push(m);
  return out;
})();

/**
 * Inline editor for one class row. Native HTML controls (no library):
 * a `<select>` for location, day, and duration; a 24-hour `<input
 * type="time">` for start; a number input bounded by `levelRatio` for
 * capacity.
 *
 * `levelRatio` is the level's max group size; the capacity input's
 * `max` is set from it so the browser surfaces the same gate the
 * server enforces. Defence in depth — the action layer does the same
 * comparison and the trigger does too.
 */
export function ClassEditor({
  draft,
  setDraft,
  locations,
  levelRatio,
  error,
  disabled,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  draft: ClassDraft;
  setDraft: (next: ClassDraft) => void;
  locations: Location[];
  levelRatio: number;
  error: { message: string; fields?: Record<string, string> } | null;
  disabled: boolean;
  onCancel: (() => void) | null;
  onSubmit: () => void;
  submitLabel: string;
}) {
  const fieldErr = (name: string) => error?.fields?.[name];

  return (
    <div className="flex flex-col gap-3">
      {error && !error.fields ? (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
        >
          {error.message}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Location" error={fieldErr("locationId")}>
          <select
            value={draft.locationId}
            onChange={(e) =>
              setDraft({ ...draft, locationId: e.target.value })
            }
            required
            className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">Select a location…</option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Day" error={fieldErr("dayOfWeek")}>
          <select
            value={draft.dayOfWeek}
            onChange={(e) => setDraft({ ...draft, dayOfWeek: e.target.value })}
            className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          >
            {WEEK_DAYS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Start time" error={fieldErr("startTime")}>
          <input
            type="time"
            value={draft.startTime}
            onChange={(e) => setDraft({ ...draft, startTime: e.target.value })}
            required
            className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </Field>

        <Field label="Duration" error={fieldErr("durationMinutes")}>
          <select
            value={draft.durationMinutes}
            onChange={(e) =>
              setDraft({ ...draft, durationMinutes: e.target.value })
            }
            className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          >
            {DURATION_OPTIONS.map((m) => (
              <option key={m} value={String(m)}>
                {m} min
              </option>
            ))}
          </select>
        </Field>

        <Field
          label={`Capacity (max ${levelRatio})`}
          error={fieldErr("capacity")}
        >
          <input
            type="number"
            min={1}
            max={levelRatio}
            step={1}
            value={draft.capacity}
            onChange={(e) => setDraft({ ...draft, capacity: e.target.value })}
            required
            className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </Field>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={disabled}
            className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm dark:border-zinc-700"
          >
            Cancel
          </button>
        ) : null}
        <button
          type="button"
          onClick={onSubmit}
          disabled={disabled}
          className="rounded-full bg-foreground px-4 py-1.5 text-sm text-background"
        >
          {disabled ? "Saving…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span style={FIELD_LABEL} className="text-sm">
        {label}
      </span>
      {children}
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
