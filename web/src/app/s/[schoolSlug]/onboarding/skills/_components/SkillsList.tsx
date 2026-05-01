"use client";

import { useState, useTransition } from "react";
import type { Skill } from "@/domain/types";
import { addSkill } from "../_actions/addSkill";
import { updateSkill } from "../_actions/updateSkill";
import { archiveSkill } from "../_actions/archiveSkill";
import { reorderSkills } from "../_actions/reorderSkills";
import { SkillEditor, type SkillDraft, emptySkillDraft, draftFromSkill } from "./SkillEditor";

/**
 * Per-level list of skills. Direct copy of `LevelsList`'s row shape:
 * up/down arrows, inline editor, per-row archive — no Continue / Skip
 * controls (those live at the page level via `ContinueControls`).
 *
 * One instance per accordion section. Per-row mutations call their own
 * action through `useTransition` and rely on `revalidatePath` to bring
 * the page back to truth, same as Chunk 4.
 */
export function SkillsList({
  initial,
  levelId,
  forceAddOpen,
}: {
  initial: Skill[];
  levelId: string;
  // Open the inline add editor on first render even if the list is
  // non-empty. Used by the accordion when no skills exist yet under a
  // level the operator has chosen to populate manually.
  forceAddOpen?: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState<boolean>(
    initial.length === 0 || Boolean(forceAddOpen),
  );
  const [addDraft, setAddDraft] = useState<SkillDraft>(() => emptySkillDraft());
  const [editDraft, setEditDraft] = useState<SkillDraft>(() =>
    emptySkillDraft(),
  );
  const [rowError, setRowError] = useState<{
    id: string | "new";
    message: string;
    fields?: Record<string, string>;
  } | null>(null);
  const [pending, startTransition] = useTransition();

  function startAdd() {
    setAddDraft(emptySkillDraft());
    setAdding(true);
    setRowError(null);
  }

  function startEdit(skill: Skill) {
    setEditDraft(draftFromSkill(skill));
    setEditingId(skill.id);
    setRowError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setRowError(null);
  }

  function nullableText(raw: string): string | null {
    const trimmed = raw.trim();
    return trimmed === "" ? null : trimmed;
  }

  function submitAdd() {
    setRowError(null);
    startTransition(async () => {
      const result = await addSkill({
        levelId,
        name: addDraft.name,
        description: nullableText(addDraft.description),
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
      setAddDraft(emptySkillDraft());
    });
  }

  function submitUpdate(id: string) {
    setRowError(null);
    startTransition(async () => {
      const result = await updateSkill({
        id,
        patch: {
          name: editDraft.name,
          description: nullableText(editDraft.description),
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
      const result = await archiveSkill({ id });
      if (!result.ok) {
        setRowError({ id, message: result.error.message });
      }
    });
  }

  function submitMove(index: number, direction: -1 | 1) {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= initial.length) return;
    const ids = initial.map((s) => s.id);
    const moved = ids[index]!;
    ids.splice(index, 1);
    ids.splice(newIndex, 0, moved);
    setRowError(null);
    startTransition(async () => {
      const result = await reorderSkills({ levelId, ids });
      if (!result.ok) {
        setRowError({ id: moved, message: result.error.message });
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {initial.map((skill, index) =>
          editingId === skill.id ? (
            <li
              key={skill.id}
              className="rounded-md border border-zinc-300 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-950"
            >
              <SkillEditor
                draft={editDraft}
                setDraft={setEditDraft}
                error={rowError?.id === skill.id ? rowError : null}
                disabled={pending}
                onCancel={cancelEdit}
                onSubmit={() => submitUpdate(skill.id)}
                submitLabel="Save"
              />
            </li>
          ) : (
            <li
              key={skill.id}
              className="flex items-start justify-between gap-3 rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
            >
              <div className="flex items-start gap-3">
                <div className="flex flex-col gap-1 pt-0.5">
                  <button
                    type="button"
                    onClick={() => submitMove(index, -1)}
                    disabled={pending || index === 0}
                    aria-label={`Move ${skill.name} up`}
                    className="rounded border border-zinc-300 px-2 py-0.5 text-xs disabled:opacity-30 dark:border-zinc-700"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => submitMove(index, 1)}
                    disabled={pending || index === initial.length - 1}
                    aria-label={`Move ${skill.name} down`}
                    className="rounded border border-zinc-300 px-2 py-0.5 text-xs disabled:opacity-30 dark:border-zinc-700"
                  >
                    ▼
                  </button>
                </div>
                <div className="flex flex-col gap-0.5 text-sm">
                  <span className="font-medium">{skill.name}</span>
                  {skill.description ? (
                    <p className="text-xs text-zinc-600 dark:text-zinc-400">
                      {skill.description}
                    </p>
                  ) : null}
                  {rowError?.id === skill.id && !rowError.fields ? (
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
                  onClick={() => startEdit(skill)}
                  disabled={pending}
                  className="rounded-full border border-zinc-300 px-3 py-1 dark:border-zinc-700"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => submitArchive(skill.id)}
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
          <li className="rounded-md border border-zinc-300 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-950">
            <SkillEditor
              draft={addDraft}
              setDraft={setAddDraft}
              error={rowError?.id === "new" ? rowError : null}
              disabled={pending}
              onCancel={
                initial.length > 0
                  ? () => {
                      setAdding(false);
                      setRowError(null);
                    }
                  : null
              }
              onSubmit={submitAdd}
              submitLabel="Add skill"
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
            className="rounded-full border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
          >
            + Add another skill
          </button>
        </div>
      ) : null}
    </div>
  );
}
