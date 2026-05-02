"use client";

import { useState, useTransition } from "react";
import type { Class, ClassLevel, Location, PendingInvitation } from "@/domain/types";
import type { MembershipWithUser } from "@/repositories/membershipRepository";
import { assignTeacherToClass } from "../_actions/assignTeacherToClass";
import { unassignTeacherFromClass } from "../_actions/unassignTeacherFromClass";

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
  return `${DAY_LABEL[cls.dayOfWeek] ?? cls.dayOfWeek} ${cls.startTime.slice(0, 5)}`;
}

// Encoded as `kind:id` so a single `<select>` covers both branches.
// Empty string is the "still unassigned" sentinel; picking it triggers
// the unassign action so an operator can cancel an assignment they
// just made.
type Choice =
  | { kind: "none" }
  | { kind: "teacher"; id: string }
  | { kind: "pending"; id: string };

function parseChoice(value: string): Choice {
  if (value === "") return { kind: "none" };
  const [kind, id] = value.split(":");
  if (kind === "teacher" && id) return { kind: "teacher", id };
  if (kind === "pending" && id) return { kind: "pending", id };
  return { kind: "none" };
}

function currentChoice(cls: Class): Choice {
  if (cls.teacherId) return { kind: "teacher", id: cls.teacherId };
  if (cls.pendingTeacherInvitationId) {
    return { kind: "pending", id: cls.pendingTeacherInvitationId };
  }
  return { kind: "none" };
}

function choiceValue(c: Choice): string {
  if (c.kind === "none") return "";
  return `${c.kind}:${c.id}`;
}

/**
 * One row of the assignment list. The `<select>` mixes real teachers
 * and pending invitations as `kind:id` values; choosing the empty
 * "Unassigned" option fires the unassign action.
 *
 * Errors surface inline. The page revalidates on success so the row's
 * derived state matches the row above (e.g. removing the last
 * unassigned class makes the row drop out of `listUnassigned`).
 */
export function AssignmentRow({
  cls,
  level,
  location,
  teachers,
  invitations,
}: {
  cls: Class;
  level: ClassLevel | undefined;
  location: Location | undefined;
  teachers: MembershipWithUser[];
  invitations: PendingInvitation[];
}) {
  const initial = currentChoice(cls);
  const [value, setValue] = useState<string>(choiceValue(initial));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(next: string) {
    setValue(next);
    setError(null);
    const choice = parseChoice(next);
    startTransition(async () => {
      const result =
        choice.kind === "none"
          ? await unassignTeacherFromClass({ classId: cls.id })
          : await assignTeacherToClass({
              classId: cls.id,
              assignment:
                choice.kind === "teacher"
                  ? { kind: "teacher", teacherId: choice.id }
                  : { kind: "pending", invitationId: choice.id },
            });
      if (!result.ok) {
        setError(result.error.message);
        // Revert local state so the dropdown matches the unchanged row.
        setValue(choiceValue(initial));
      }
    });
  }

  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-col gap-0.5 text-sm">
        <span className="font-medium">{formatDayTime(cls)}</span>
        <span className="text-xs text-zinc-600 dark:text-zinc-400">
          {level?.name ?? "(unknown level)"} ·{" "}
          {location?.name ?? "(unknown location)"} · capacity {cls.capacity}
        </span>
        {error ? (
          <span className="text-xs text-red-600 dark:text-red-400" role="alert">
            {error}
          </span>
        ) : null}
      </div>
      <select
        value={value}
        onChange={(e) => submit(e.target.value)}
        disabled={pending}
        className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        <option value="">Unassigned</option>
        {teachers.length > 0 ? (
          <optgroup label="Teachers">
            {teachers.map((t) => (
              <option key={`teacher-${t.userId}`} value={`teacher:${t.userId}`}>
                {t.name || t.email}
              </option>
            ))}
          </optgroup>
        ) : null}
        {invitations.length > 0 ? (
          <optgroup label="Pending invitations">
            {invitations.map((inv) => (
              <option key={`pending-${inv.id}`} value={`pending:${inv.id}`}>
                {inv.email} (pending)
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    </li>
  );
}
