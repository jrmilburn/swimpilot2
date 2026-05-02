import type { Class, ClassLevel, Location, PendingInvitation } from "@/domain/types";
import type { MembershipWithUser } from "@/repositories/membershipRepository";
import { AssignmentRow } from "./AssignmentRow";

/**
 * "Still open" classes — `teacher_id` and
 * `pending_teacher_invitation_id` both null. Once a class is assigned,
 * it falls off this list (the page rebuilds the list off
 * `listUnassigned`). Reads as a punch list of remaining slots.
 */
export function AssignmentList({
  classes,
  levelsById,
  locationsById,
  teachers,
  invitations,
}: {
  classes: Class[];
  levelsById: Record<string, ClassLevel>;
  locationsById: Record<string, Location>;
  teachers: MembershipWithUser[];
  invitations: PendingInvitation[];
}) {
  if (classes.length === 0) {
    return (
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Unassigned classes</h3>
        <p className="rounded-md border border-zinc-200 bg-white p-4 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
          Every class has a teacher (or a pending invite). Nothing left
          to assign.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">
        Unassigned classes ({classes.length})
      </h3>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        Pick a teacher or a pending invitation for each class. Picking
        a pending invite parks the class — once the invitee signs up,
        the class moves to them automatically.
      </p>
      <ul className="flex flex-col gap-2">
        {classes.map((cls) => (
          <AssignmentRow
            key={cls.id}
            cls={cls}
            level={levelsById[cls.levelId]}
            location={locationsById[cls.locationId]}
            teachers={teachers}
            invitations={invitations}
          />
        ))}
      </ul>
    </section>
  );
}
