"use client";

import { useState, useTransition } from "react";
import type { Class, Location } from "@/domain/types";
import { addClass } from "../_actions/addClass";
import { updateClass } from "../_actions/updateClass";
import { archiveClass } from "../_actions/archiveClass";
import {
  ClassEditor,
  type ClassDraft,
  emptyClassDraft,
  draftFromClass,
} from "./ClassEditor";

const DAY_LABEL: Record<string, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

function formatDayTime(cls: Class) {
  return `${DAY_LABEL[cls.dayOfWeek] ?? cls.dayOfWeek} ${cls.startTime.slice(0, 5)} · ${cls.durationMinutes} min`;
}

function locationName(locations: Location[], id: string): string {
  return locations.find((l) => l.id === id)?.name ?? "(unknown location)";
}

/**
 * Per-level list of classes inside the accordion. Mirrors `SkillsList`
 * — inline editor with per-row Edit / Remove, single Add slot at the
 * bottom. No reorder arrows: classes don't carry an order_index, the
 * repository sorts by `(dayOfWeek, startTime)` at read time.
 *
 * Add capacity defaults to `min(4, levelRatio)`. Operators usually start
 * with a small group; the level's ratio caps it. The action layer and
 * trigger both re-validate.
 */
export function ClassesList({
  initial,
  levelId,
  levelRatio,
  locations,
}: {
  initial: Class[];
  levelId: string;
  levelRatio: number;
  locations: Location[];
}) {
  const defaultCapacity = Math.min(4, levelRatio);
  const defaultLocationId = locations[0]?.id ?? "";
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState<boolean>(initial.length === 0);
  const [addDraft, setAddDraft] = useState<ClassDraft>(() =>
    emptyClassDraft({ locationId: defaultLocationId, capacity: defaultCapacity }),
  );
  const [editDraft, setEditDraft] = useState<ClassDraft>(() =>
    emptyClassDraft({ locationId: defaultLocationId, capacity: defaultCapacity }),
  );
  const [rowError, setRowError] = useState<{
    id: string | "new";
    message: string;
    fields?: Record<string, string>;
  } | null>(null);
  const [pending, startTransition] = useTransition();

  function startAdd() {
    setAddDraft(
      emptyClassDraft({
        locationId: defaultLocationId,
        capacity: defaultCapacity,
      }),
    );
    setAdding(true);
    setRowError(null);
  }

  function startEdit(cls: Class) {
    setEditDraft(draftFromClass(cls));
    setEditingId(cls.id);
    setRowError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setRowError(null);
  }

  function parseDraftPayload(draft: ClassDraft) {
    return {
      locationId: draft.locationId,
      dayOfWeek: draft.dayOfWeek,
      startTime: draft.startTime,
      durationMinutes: Number.parseInt(draft.durationMinutes, 10),
      capacity: Number.parseInt(draft.capacity, 10),
    };
  }

  function submitAdd() {
    setRowError(null);
    startTransition(async () => {
      const result = await addClass({ levelId, ...parseDraftPayload(addDraft) });
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
      setAddDraft(
        emptyClassDraft({
          locationId: defaultLocationId,
          capacity: defaultCapacity,
        }),
      );
    });
  }

  function submitUpdate(id: string) {
    setRowError(null);
    startTransition(async () => {
      const result = await updateClass({ id, patch: parseDraftPayload(editDraft) });
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
      const result = await archiveClass({ id });
      if (!result.ok) {
        setRowError({ id, message: result.error.message });
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {initial.map((cls) =>
          editingId === cls.id ? (
            <li
              key={cls.id}
              className="rounded-md border border-zinc-300 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-950"
            >
              <ClassEditor
                draft={editDraft}
                setDraft={setEditDraft}
                locations={locations}
                levelRatio={levelRatio}
                error={rowError?.id === cls.id ? rowError : null}
                disabled={pending}
                onCancel={cancelEdit}
                onSubmit={() => submitUpdate(cls.id)}
                submitLabel="Save"
              />
            </li>
          ) : (
            <li
              key={cls.id}
              className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
            >
              <div className="flex flex-col gap-0.5 text-sm">
                <span className="font-medium">{formatDayTime(cls)}</span>
                <span className="text-xs text-zinc-600 dark:text-zinc-400">
                  {locationName(locations, cls.locationId)} · capacity{" "}
                  {cls.capacity}
                </span>
                {rowError?.id === cls.id && !rowError.fields ? (
                  <span
                    role="alert"
                    className="text-xs text-red-600 dark:text-red-400"
                  >
                    {rowError.message}
                  </span>
                ) : null}
              </div>
              <div className="flex gap-2 text-sm">
                <button
                  type="button"
                  onClick={() => startEdit(cls)}
                  disabled={pending}
                  className="rounded-full border border-zinc-300 px-3 py-1 dark:border-zinc-700"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => submitArchive(cls.id)}
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
            <ClassEditor
              draft={addDraft}
              setDraft={setAddDraft}
              locations={locations}
              levelRatio={levelRatio}
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
              submitLabel="Add class"
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
            + Add another class
          </button>
        </div>
      ) : null}
    </div>
  );
}
