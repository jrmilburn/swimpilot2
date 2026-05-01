"use client";

import { useState, useTransition, useActionState } from "react";
import type { ClassLevel } from "@/domain/types";
import { addLevel } from "../_actions/addLevel";
import { updateLevel } from "../_actions/updateLevel";
import { archiveLevel } from "../_actions/archiveLevel";
import { reorderLevels } from "../_actions/reorderLevels";
import {
  type LevelsFormState,
  initialLevelsFormState,
  saveLevelsForm,
} from "../_actions/saveLevelsForm";

type LevelDraft = {
  name: string;
  description: string;
  ratio: string;
  defaultProgressionThreshold: string;
  minAgeMonths: string;
  maxAgeMonths: string;
};

const FIELD_LABEL: React.CSSProperties = { fontWeight: 500 };

const emptyDraft = (): LevelDraft => ({
  name: "",
  description: "",
  ratio: "8",
  defaultProgressionThreshold: "80",
  minAgeMonths: "",
  maxAgeMonths: "",
});

const draftFromLevel = (level: ClassLevel): LevelDraft => ({
  name: level.name,
  description: level.description ?? "",
  ratio: String(level.ratio),
  defaultProgressionThreshold: String(level.defaultProgressionThreshold),
  minAgeMonths:
    level.minAgeMonths == null ? "" : String(level.minAgeMonths),
  maxAgeMonths:
    level.maxAgeMonths == null ? "" : String(level.maxAgeMonths),
});

function nullableText(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function nullableInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : NaN;
}

function intOrNan(raw: string): number {
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) ? Math.trunc(parsed) : NaN;
}

export function LevelsList({
  initial,
  schoolSlug,
  forceAddOpen,
}: {
  initial: ClassLevel[];
  schoolSlug: string;
  // True when `?mode=scratch` was passed in — we render the empty state
  // with the editor already open (operator dismissed the prompt).
  forceAddOpen: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState<boolean>(
    initial.length === 0 && forceAddOpen,
  );
  const [addDraft, setAddDraft] = useState<LevelDraft>(() => emptyDraft());
  const [editDraft, setEditDraft] = useState<LevelDraft>(() => emptyDraft());
  const [rowError, setRowError] = useState<{
    id: string | "new";
    message: string;
    fields?: Record<string, string>;
  } | null>(null);
  const [pending, startTransition] = useTransition();

  const boundAction = saveLevelsForm.bind(null, schoolSlug);
  const [continueState, continueAction, continuePending] = useActionState<
    LevelsFormState,
    FormData
  >(boundAction, initialLevelsFormState);

  const hasLevels = initial.length > 0;
  const saveDisabled = !hasLevels || continuePending || pending;
  const skipDisabled = continuePending || pending;

  function startAdd() {
    setAddDraft(emptyDraft());
    setAdding(true);
    setRowError(null);
  }

  function startEdit(level: ClassLevel) {
    setEditDraft(draftFromLevel(level));
    setEditingId(level.id);
    setRowError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setRowError(null);
  }

  function submitAdd() {
    setRowError(null);
    startTransition(async () => {
      const result = await addLevel({
        name: addDraft.name,
        description: nullableText(addDraft.description),
        ratio: intOrNan(addDraft.ratio),
        defaultProgressionThreshold: intOrNan(
          addDraft.defaultProgressionThreshold,
        ),
        minAgeMonths: nullableInt(addDraft.minAgeMonths),
        maxAgeMonths: nullableInt(addDraft.maxAgeMonths),
      });
      if (!result.ok) {
        setRowError({
          id: "new",
          message: result.error.message,
          fields:
            result.error.code === "VALIDATION"
              ? result.error.fieldErrors
              : undefined,
        });
        return;
      }
      setAdding(false);
      setAddDraft(emptyDraft());
    });
  }

  function submitUpdate(id: string) {
    setRowError(null);
    startTransition(async () => {
      const result = await updateLevel({
        id,
        patch: {
          name: editDraft.name,
          description: nullableText(editDraft.description),
          ratio: intOrNan(editDraft.ratio),
          defaultProgressionThreshold: intOrNan(
            editDraft.defaultProgressionThreshold,
          ),
          minAgeMonths: nullableInt(editDraft.minAgeMonths),
          maxAgeMonths: nullableInt(editDraft.maxAgeMonths),
        },
      });
      if (!result.ok) {
        setRowError({
          id,
          message: result.error.message,
          fields:
            result.error.code === "VALIDATION"
              ? result.error.fieldErrors
              : undefined,
        });
        return;
      }
      setEditingId(null);
    });
  }

  function submitArchive(id: string) {
    setRowError(null);
    startTransition(async () => {
      const result = await archiveLevel({ id });
      if (!result.ok) {
        setRowError({ id, message: result.error.message });
      }
    });
  }

  function submitMove(index: number, direction: -1 | 1) {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= initial.length) return;
    const ids = initial.map((l) => l.id);
    const moved = ids[index]!;
    ids.splice(index, 1);
    ids.splice(newIndex, 0, moved);
    setRowError(null);
    startTransition(async () => {
      const result = await reorderLevels({ ids });
      if (!result.ok) {
        setRowError({
          id: moved,
          message: result.error.message,
        });
      }
    });
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <ul className="flex flex-col gap-3">
        {initial.map((level, index) =>
          editingId === level.id ? (
            <li
              key={level.id}
              className="rounded-md border border-zinc-300 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-950"
            >
              <LevelEditor
                draft={editDraft}
                setDraft={setEditDraft}
                error={rowError?.id === level.id ? rowError : null}
                disabled={pending}
                onCancel={cancelEdit}
                onSubmit={() => submitUpdate(level.id)}
                submitLabel="Save"
              />
            </li>
          ) : (
            <li
              key={level.id}
              className="flex items-start justify-between gap-3 rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
            >
              <div className="flex items-start gap-3">
                <div className="flex flex-col gap-1 pt-0.5">
                  <button
                    type="button"
                    onClick={() => submitMove(index, -1)}
                    disabled={pending || index === 0}
                    aria-label={`Move ${level.name} up`}
                    className="rounded border border-zinc-300 px-2 py-0.5 text-xs disabled:opacity-30 dark:border-zinc-700"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => submitMove(index, 1)}
                    disabled={pending || index === initial.length - 1}
                    aria-label={`Move ${level.name} down`}
                    className="rounded border border-zinc-300 px-2 py-0.5 text-xs disabled:opacity-30 dark:border-zinc-700"
                  >
                    ▼
                  </button>
                </div>
                <div className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">{level.name}</span>
                  <LevelSummary level={level} />
                  {rowError?.id === level.id && !rowError.fields ? (
                    <span
                      role="alert"
                      className="text-xs text-red-600 dark:text-red-400"
                    >
                      {rowError.message}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="flex gap-2 text-sm">
                <button
                  type="button"
                  onClick={() => startEdit(level)}
                  disabled={pending}
                  className="rounded-full border border-zinc-300 px-3 py-1 dark:border-zinc-700"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => submitArchive(level.id)}
                  disabled={pending}
                  className="rounded-full border border-red-300 px-3 py-1 text-red-700 dark:border-red-800 dark:text-red-300"
                >
                  Remove
                </button>
              </div>
            </li>
          ),
        )}
        {adding ? (
          <li className="rounded-md border border-zinc-300 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-950">
            <LevelEditor
              draft={addDraft}
              setDraft={setAddDraft}
              error={rowError?.id === "new" ? rowError : null}
              disabled={pending}
              onCancel={
                hasLevels
                  ? () => {
                      setAdding(false);
                      setRowError(null);
                    }
                  : null
              }
              onSubmit={submitAdd}
              submitLabel="Add level"
            />
          </li>
        ) : null}
      </ul>

      {!adding ? (
        <div>
          <button
            type="button"
            onClick={startAdd}
            disabled={pending}
            className="rounded-full border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
          >
            + Add another level
          </button>
        </div>
      ) : null}

      <form
        action={continueAction}
        className="flex flex-col items-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800"
      >
        {continueState.fieldErrors._form ? (
          <div
            role="alert"
            className="w-full rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
          >
            {continueState.fieldErrors._form}
          </div>
        ) : null}
        {!hasLevels ? (
          <p className="w-full text-xs text-zinc-500">
            Skills attach to levels — you&apos;ll need at least one level
            before adding skills. You can come back to this.
          </p>
        ) : null}
        <div className="flex gap-2">
          <button
            type="submit"
            name="intent"
            value="skip"
            disabled={skipDisabled}
            className="rounded-full border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
          >
            {continuePending ? "Working…" : "Skip for now"}
          </button>
          <button
            type="submit"
            name="intent"
            value="save"
            disabled={saveDisabled}
            className="rounded-full bg-foreground px-5 py-2 text-sm text-background disabled:opacity-50"
          >
            {continuePending ? "Saving…" : "Continue"}
          </button>
        </div>
      </form>
    </div>
  );
}

function LevelSummary({ level }: { level: ClassLevel }) {
  const ageBits: string[] = [];
  if (level.minAgeMonths != null || level.maxAgeMonths != null) {
    if (level.minAgeMonths != null && level.maxAgeMonths != null) {
      ageBits.push(`${level.minAgeMonths}–${level.maxAgeMonths} months`);
    } else if (level.minAgeMonths != null) {
      ageBits.push(`from ${level.minAgeMonths} months`);
    } else if (level.maxAgeMonths != null) {
      ageBits.push(`up to ${level.maxAgeMonths} months`);
    }
  }

  return (
    <div className="flex flex-col gap-0.5 text-xs text-zinc-600 dark:text-zinc-400">
      <span>
        Ratio 1:{level.ratio} · Progress at{" "}
        {level.defaultProgressionThreshold}%
        {ageBits.length > 0 ? ` · ${ageBits.join(", ")}` : ""}
      </span>
      {level.description ? <span>{level.description}</span> : null}
    </div>
  );
}

function LevelEditor({
  draft,
  setDraft,
  error,
  disabled,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  draft: LevelDraft;
  setDraft: (next: LevelDraft) => void;
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
          className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </Field>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Class ratio (students per teacher)" error={fieldErr("ratio")}>
          <input
            type="number"
            value={draft.ratio}
            onChange={(e) => setDraft({ ...draft, ratio: e.target.value })}
            min={1}
            max={20}
            required
            className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </Field>
        <Field
          label="Progression threshold (%)"
          error={fieldErr("defaultProgressionThreshold")}
        >
          <input
            type="number"
            value={draft.defaultProgressionThreshold}
            onChange={(e) =>
              setDraft({
                ...draft,
                defaultProgressionThreshold: e.target.value,
              })
            }
            min={0}
            max={100}
            required
            className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          />
          <p className="text-xs text-zinc-500">
            Share of skills required before a student is suggested for the
            next level.
          </p>
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Minimum age (months)" error={fieldErr("minAgeMonths")}>
          <input
            type="number"
            value={draft.minAgeMonths}
            onChange={(e) =>
              setDraft({ ...draft, minAgeMonths: e.target.value })
            }
            min={0}
            max={1200}
            placeholder="optional"
            className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </Field>
        <Field label="Maximum age (months)" error={fieldErr("maxAgeMonths")}>
          <input
            type="number"
            value={draft.maxAgeMonths}
            onChange={(e) =>
              setDraft({ ...draft, maxAgeMonths: e.target.value })
            }
            min={0}
            max={1200}
            placeholder="optional"
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
