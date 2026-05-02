"use client";

import { useTransition } from "react";
import type { PendingInvitation } from "@/domain/types";
import type { MembershipWithUser } from "@/repositories/membershipRepository";
import { revokePendingInvitation } from "../_actions/revokePendingInvitation";

/**
 * Two-section roster: real teachers (memberships with role='teacher')
 * on top, then pending invitations. Both are optional — a school can
 * complete the Teachers step with neither.
 *
 * Per-row actions:
 *   - Real teacher row: read-only this chunk. Sprint 5 / Chunk 2 adds
 *     "remove from school" once the dashboard surfaces it.
 *   - Pending invitation row: "Revoke" calls the action, which clears
 *     any classes parked on the invitation and flips the row to
 *     `status='revoked'`.
 */
export function TeacherRoster({
  teachers,
  invitations,
}: {
  teachers: MembershipWithUser[];
  invitations: PendingInvitation[];
}) {
  const [pending, startTransition] = useTransition();

  function submitRevoke(invitationId: string) {
    startTransition(async () => {
      await revokePendingInvitation({ invitationId });
    });
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Teachers ({teachers.length})</h3>
        {teachers.length === 0 ? (
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            No teachers yet. Invite a teacher below — they&apos;ll appear
            here once they sign up.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {teachers.map((t) => (
              <li
                key={t.membershipId}
                className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
              >
                <div className="flex flex-col gap-0.5 text-sm">
                  <span className="font-medium">{t.name || t.email}</span>
                  {t.name ? (
                    <span className="text-xs text-zinc-600 dark:text-zinc-400">
                      {t.email}
                    </span>
                  ) : null}
                </div>
                <span className="text-xs uppercase tracking-wide text-zinc-500">
                  {t.role}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">
          Pending invitations ({invitations.length})
        </h3>
        {invitations.length === 0 ? (
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            No pending invitations.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {invitations.map((inv) => (
              <li
                key={inv.id}
                className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
              >
                <div className="flex flex-col gap-0.5 text-sm">
                  <span className="font-medium">{inv.email}</span>
                  <span className="text-xs text-zinc-500">
                    Invited {inv.createdAt.toLocaleDateString()} · pending
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => submitRevoke(inv.id)}
                  disabled={pending}
                  className="rounded-full border border-red-300 px-3 py-1 text-sm text-red-700 dark:border-red-800 dark:text-red-300"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
