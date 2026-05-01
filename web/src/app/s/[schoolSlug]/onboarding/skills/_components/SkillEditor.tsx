"use client";

import type { Skill } from "@/domain/types";

export type SkillDraft = {
  name: string;
  description: string;
};

export const emptySkillDraft = (): SkillDraft => ({ name: "", description: "" });

export const draftFromSkill = (skill: Skill): SkillDraft => ({
  name: skill.name,
  description: skill.description ?? "",
});

const FIELD_LABEL: React.CSSProperties = { fontWeight: 500 };

/**
 * Inline editor for one skill row. Plain-text description in a
 * `<textarea>` — no markdown, no rich text (per spec). Mirrors
 * `LevelEditor`'s shape but with the narrower field set.
 */
export function SkillEditor({
  draft,
  setDraft,
  error,
  disabled,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  draft: SkillDraft;
  setDraft: (next: SkillDraft) => void;
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

      <Field label="Name" error={fieldErr("name")}>
        <input
          type="text"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          maxLength={100}
          required
          className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </Field>

      <Field label="Description" error={fieldErr("description")}>
        <textarea
          value={draft.description}
          onChange={(e) =>
            setDraft({ ...draft, description: e.target.value })
          }
          rows={2}
          maxLength={1000}
          placeholder="Plain text — what does the student need to demonstrate?"
          className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </Field>

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
