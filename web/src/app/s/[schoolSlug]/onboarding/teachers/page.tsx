import { requireTenant } from "@/lib/auth/requireTenant";
import { withTenant } from "@/lib/db/withTenant";
import { Role } from "@/domain/enums";
import * as classRepository from "@/repositories/classRepository";
import * as classLevelRepository from "@/repositories/classLevelRepository";
import * as locationRepository from "@/repositories/locationRepository";
import * as membershipRepository from "@/repositories/membershipRepository";
import * as pendingInvitationRepository from "@/repositories/pendingInvitationRepository";
import { TeacherRoster } from "./_components/TeacherRoster";
import { InviteTeacherForm } from "./_components/InviteTeacherForm";
import { AssignmentList } from "./_components/AssignmentList";
import { ContinueControls } from "./_components/ContinueControls";

/**
 * Sprint 5 / Chunk 1 — the Teachers step.
 *
 * Page layout, top to bottom:
 *   1. Roster: real teachers (memberships role='teacher') + pending
 *      invitations. Read-only for real teachers; "Revoke" per pending
 *      row.
 *   2. Invite form: email-only. Calls Clerk and creates a
 *      `pending_invitations` row.
 *   3. Assignment list: classes with no teacher AND no pending invite.
 *      Per-row dropdown picks either a real teacher or a pending
 *      invitation.
 *   4. Continue / Skip pair. Neither path requires a count gate —
 *      Teachers is fully optional.
 */
export default async function TeachersStepPage({
  params,
}: {
  params: Promise<{ schoolSlug: string }>;
}) {
  const { schoolSlug } = await params;
  const { schoolId, userId } = await requireTenant(schoolSlug);

  const {
    teachers,
    invitations,
    unassigned,
    levelsById,
    locationsById,
  } = await withTenant({ schoolId, userId }, async (tx) => {
    const [teachers, invitations, unassigned, levels, locations] =
      await Promise.all([
        membershipRepository.listByRole(tx, Role.Teacher),
        pendingInvitationRepository.listBySchool(tx),
        classRepository.listUnassigned(tx),
        classLevelRepository.listBySchool(tx),
        locationRepository.listBySchool(tx),
      ]);
    const levelsById = Object.fromEntries(levels.map((l) => [l.id, l]));
    const locationsById = Object.fromEntries(locations.map((l) => [l.id, l]));
    return { teachers, invitations, unassigned, levelsById, locationsById };
  });

  return (
    <section className="flex flex-1 flex-col items-center px-6 py-10">
      <div className="flex w-full max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h2 className="text-xl font-semibold tracking-tight">
            Add your teachers
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Invite the teachers you&apos;ll roster classes against. You
            can park a class on a pending invite — once the teacher
            signs up, the class moves to them automatically. Adding
            teachers is optional; you can come back later.
          </p>
        </header>

        <TeacherRoster teachers={teachers} invitations={invitations} />

        <InviteTeacherForm />

        <AssignmentList
          classes={unassigned}
          levelsById={levelsById}
          locationsById={locationsById}
          teachers={teachers}
          invitations={invitations}
        />

        <ContinueControls schoolSlug={schoolSlug} />
      </div>
    </section>
  );
}
