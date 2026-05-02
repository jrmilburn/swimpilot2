"use client";

import type { ImportMapping, ImportTargetField } from "@/domain/types";

// Externally controllable. The Import page lifts mapping state so a
// future Chunk 3 "AI suggestions" panel can call `onChange` to
// preview-then-apply a different mapping. Internal state would shut
// that door.
//
// Props are deliberately narrow: `headers` for the rows to render,
// `value` for the current mapping (one entry per header), `onChange`
// for the lift, and `disabled` for when the page is mid-action.

export type MappingPanelProps = {
  headers: string[];
  value: ImportMapping;
  onChange: (next: ImportMapping) => void;
  disabled?: boolean;
};

const TARGET_OPTIONS: Array<{ value: ImportTargetField | "ignore"; label: string }> = [
  { value: "ignore", label: "Ignore this column" },
  { value: "family.primary_contact_name", label: "Family · contact name" },
  { value: "family.primary_contact_email", label: "Family · contact email" },
  { value: "family.primary_contact_phone", label: "Family · contact phone" },
  { value: "student.first_name", label: "Student · first name" },
  { value: "student.last_name", label: "Student · last name" },
  { value: "student.date_of_birth", label: "Student · date of birth" },
  { value: "enrolment.level_name", label: "Enrolment · level name" },
  { value: "enrolment.day", label: "Enrolment · day" },
  { value: "enrolment.time", label: "Enrolment · time" },
  { value: "enrolment.frequency", label: "Enrolment · frequency" },
];

export function MappingPanel({
  headers,
  value,
  onChange,
  disabled,
}: MappingPanelProps) {
  return (
    <div
      className="flex flex-col gap-2"
      data-testid="import-mapping-panel"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        Match your CSV columns
      </p>
      <ul className="flex flex-col divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {headers.map((header) => {
          const current = value[header] ?? "ignore";
          return (
            <li
              key={header}
              className="flex items-center gap-3 px-3 py-2 text-sm"
            >
              <span
                className="min-w-[10rem] truncate font-mono text-zinc-700 dark:text-zinc-300"
                title={header}
              >
                {header}
              </span>
              <span aria-hidden className="text-zinc-400">→</span>
              <select
                aria-label={`Map column ${header}`}
                value={current}
                disabled={disabled}
                onChange={(e) => {
                  const next: ImportMapping = { ...value };
                  next[header] = e.target.value as ImportTargetField | "ignore";
                  onChange(next);
                }}
                className="flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              >
                {TARGET_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
