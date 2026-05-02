# Sprint 5 / Chunk 1 — handoff

The big chunk: real Classes step + Teachers step (Clerk
invitations, atomic-swap class assignment) + an Import stub that
flips the wizard's `completed_at`. The Sprint 4 short-circuit at
Skills→Classes is gone; the wizard now walks Profile → Locations
→ Levels → Skills → Classes → Teachers → Import → Done.

This chunk introduces three new pieces of architecture that hadn't
shown up in earlier sprints:

1. A second tenant-scoped table that points at a tenant-scoped
   table on the same row (`classes.pending_teacher_invitation_id`)
   — and the XOR CHECK plus consistency trigger that keep it
   coherent with the existing `teacher_id`.
2. A SECURITY DEFINER lookup that runs **before** any tenant
   context is bound (`app_find_pending_invitations_for_email`),
   reused in the sign-in-redirect path.
3. A "park work on a pending invitation, swap onto the real
   teacher when they accept" pattern. The atomic swap is a single
   `UPDATE` so the XOR CHECK fires on the resulting row, never on
   intermediate state.

`docs/security.md` carries the full rationale for (2) and (3).
The migration's preamble carries (1).

## What landed

### Migration: `20260525120000_add_pending_invitations_and_class_pending_teacher`

- New `pending_invitation_status` enum (`pending`, `accepted`,
  `revoked`, `expired`).
- New `pending_invitations` table: tenant-scoped, soft-deletable,
  audit-fielded, RLS'd, with the partial unique index
  `(school_id, lower(email)) WHERE status = 'pending' AND deleted_at IS NULL`
  and a `pending_invitations_accepted_consistency_check` CHECK
  that keeps `accepted_user_id` / `accepted_at` either both NULL
  or both NOT NULL with `status = 'accepted'`.
- New nullable column `classes.pending_teacher_invitation_id`
  with FK back to `pending_invitations(id)`.
- New `classes_teacher_xor_pending_check` CHECK forbidding both
  `teacher_id` and `pending_teacher_invitation_id` being non-null
  on the same row.
- Existing `classes_consistency` trigger extended to also enforce
  the pending invitation's school + status when set.
- New `app_find_pending_invitations_for_email(text)` SECURITY
  DEFINER function. The decision to use a SECURITY DEFINER
  function here (and not webhook + cross-tenant tx) is documented
  in `docs/security.md`.

The migration's preamble walks through every choice: why no
unique on `(school_id, location_id, day_of_week, start_time)`
(multi-lane pools), why XOR not "exactly one" (an unassigned
class is legitimate), why partial unique on email (revoked /
accepted rows must not block re-invites).

### Repositories

- `pendingInvitationRepository` (new):
  - `findPendingForEmailAcrossSchools(email)` — wraps the
    SECURITY DEFINER function. Callable outside any tenant
    context.
  - `getById`, `getPendingByEmail`, `listBySchool`, `create`,
    `markAccepted`, `markRevoked`, `markExpired` — standard
    tenant-scoped CRUD, with the `P2002` mapper translating the
    partial-unique-index collision into a typed
    `ValidationError(email)`.
- `membershipRepository` extended:
  - `listByRole(db, role)` — denormalised "membership + user"
    rows for the Teachers roster.
  - `upsertOnAcceptance(db, …)` — raw SQL `INSERT ... ON CONFLICT
    (school_id, user_id) DO UPDATE SET deleted_at = NULL,
    updated_by = …`. Used by the sign-in-redirect path to
    re-activate a soft-deleted membership without overwriting the
    operator-set role.
- `classRepository` extended:
  - `swapPendingInvitationToTeacher(db, invitationId, teacherId)`
    — single `updateMany` that flips every row from `pending` to
    `teacher` in one statement, returning the affected count.
  - `listUnassigned(db)` — for the Teachers step's "still open"
    list.
  - `listByLocation(db)` / `listByLevel(db)` — used by the
    Classes step's grouped accordion.

### Sign-in-redirect path: `src/lib/auth/resolveAcceptedInvitation.ts`

Called from `src/app/page.tsx` after the Clerk-DB user upsert
and before `listUserMemberships`. Walks every still-pending
invitation matching the user's lowercased email; for each, runs
a per-school `withTenant` transaction that:

1. Upserts the membership (`ON CONFLICT DO UPDATE` clears
   `deleted_at`, preserves role).
2. Flips the invitation to `accepted`.
3. Atomically swaps any classes parked on the invitation onto
   `teacher_id = userId`.

Idempotent. Per-school finalisations are wrapped in their own
try/catch — a failure in one school can't roll back another's,
and no error escapes back to the landing page (worst case: the
"no schools yet" view paints, the next sign-in retries).

The helper itself does not import Prisma directly — every
mutation goes through one of the three repository functions
above. This is what `no-restricted-imports` enforces for
`src/lib/auth/**`.

### Classes step

`/onboarding/classes/`:
- `page.tsx` — server component. Reads location list, level
  list, and the per-location class list via the existing
  repositories under `requireTenant`. Renders one
  `ClassesAccordion` per location with a `ClassesList` body and
  a `ClassEditor` for the inline create / edit form.
- `_components/ClassesAccordion.tsx`, `ClassesList.tsx`,
  `ClassEditor.tsx` — the grouped UI. Editor is a single
  `useActionState` form that switches between create and update
  intents based on whether `classId` is in the row's hidden
  field. The capacity-vs-ratio pre-check fires in the action
  before the row hits the DB; the trigger is the second line of
  defence.
- `_actions/`:
  - `addClass`, `updateClass`, `archiveClass` — typed
    `tenantAction`s. `archiveClass` is the Sprint 5 soft-delete
    pattern (`deleted_at = now()` via the repo).
  - `markClassesComplete` — save path requires ≥1 class on the
    school; skip path is unconditional. Both paths call
    `markStepStatus({ nextStep: OnboardingStep.Teachers })`.
  - `classFields.ts` — shared zod field schemas, including
    `capacityExceedsRatioMessage` whose wording matches the
    Postgres trigger's `RAISE EXCEPTION` byte-for-byte.
  - `saveClassesForm.ts` — the `useActionState` bridge.
  - `ContinueControls.tsx` — Continue / Skip pair.

### Teachers step

`/onboarding/teachers/`:
- `page.tsx` — three sections: Roster (existing teacher
  memberships), Pending (open Clerk invitations), Assignment list
  (still-unassigned classes).
- `_components/TeacherRoster.tsx`, `InviteTeacherForm.tsx`,
  `AssignmentList.tsx`, `AssignmentRow.tsx`, `ContinueControls.tsx`.
- `_actions/`:
  - `inviteTeacher` — pre-check duplicate, Clerk
    `createInvitation` (must succeed *before* DB write so a Clerk
    failure doesn't leave a row referencing a non-existent
    invitation), then persist `pending_invitations` row with the
    Clerk id.
  - `revokePendingInvitation` — best-effort Clerk-side revoke;
    clears classes parked on the invitation **before** flipping
    the row's status (the consistency trigger forbids
    `pending_teacher_invitation_id` pointing at a non-pending row,
    so leaving classes attached after the flip would put the DB
    in a state that re-validates as a `check_violation` on the
    next class update).
  - `assignTeacherToClass` / `unassignTeacherFromClass` — single
    `UPDATE` that sets one column and explicitly nulls the other
    so the XOR CHECK fires on the resulting row, not intermediate
    state.
  - `markTeachersComplete` — no count gate. Both paths advance
    to `OnboardingStep.Import`.

### Import step (stub)

`/onboarding/import/`:
- `page.tsx` — "Import students" header, two-paragraph copy
  explaining we'll wire CSV import in a later sprint, plus the
  `ContinueControls`. No data reads.
- `_actions/markImportComplete.ts` — flips the wizard's
  `completed_at` via `onboardingProgressRepository.complete`.
  This is the seam that ends onboarding; the redirect is to
  `/s/<slug>` (dashboard).
- `_actions/saveImportForm.ts` — `useActionState` bridge. Both
  Continue and Skip call `markImportComplete` and redirect on
  success.

### Domain / wizard

- `OnboardingStep` extended to include `teachers` and `import`.
- `WIZARD_STEPS` is now seven entries: profile, locations,
  levels, skills, classes, teachers, import. The progress
  indicator picks them up automatically.
- `Role` and `PendingInvitationStatus` exported from
  `domain/enums.ts` as runtime const objects (matching the
  existing pattern).
- `PendingInvitation` interface added to `domain/types.ts`.
- `auditExtension` (`src/lib/db/extensions.ts`) updated to
  include `PendingInvitation` in `DOMAIN_MODELS` so
  `created_by` / `updated_by` are auto-stamped.

### Documentation

- `docs/security.md` gained two new sections:
  - **classes atomic-swap on assignment** — explains the XOR
    CHECK and the single-`UPDATE` discipline.
  - **Pending invitations: cross-tenant lookup at sign-in** —
    explains the SECURITY DEFINER function, the
    sign-in-redirect-vs-webhook decision, and why
    `withTenant`-per-invitation is the right transaction
    boundary.

## Decisions made in this chunk

1. **Sign-in-redirect, not Clerk webhook, for invitation
   acceptance.** A webhook would have to look up `(email →
   schoolIds)` itself and would race with the user's first page
   render. The redirect path is synchronous with the user's
   landing on `/`, so the first page they see already reflects
   the new memberships. Cost: a few hundred ms on first sign-in
   per pending invite. Documented in `docs/security.md`.

2. **`pending_teacher_invitation_id` as a separate column, not
   a polymorphic "assignee" jsonb.** The XOR CHECK is trivial as
   two columns; as a jsonb shape it would have to be enforced in
   trigger code. The consistency trigger already had to know
   about `teacher_id`'s membership, so adding the parallel
   `pending_invitation` lookup is the same shape of work in the
   same place.

3. **Atomic swap, not delete-then-insert.** The CHECK
   `NOT (teacher_id IS NOT NULL AND pending_teacher_invitation_id
   IS NOT NULL)` fires on the resulting row, so a single `UPDATE
   SET teacher_id = …, pending_teacher_invitation_id = NULL` is
   correct without a deferred-constraint dance. Same shape used
   for the sign-in-redirect swap and for re-assignment in the
   Teachers step.

4. **`upsertOnAcceptance` preserves role on conflict.** A
   re-invitation arriving for a soft-deleted membership
   re-activates the row but does not silently change the role —
   operators may have intentionally adjusted role between the
   original invite and the re-invite. The DB row, not the
   invitation, is the source of truth for role.

5. **Capacity wording mirrored byte-for-byte from the trigger.**
   `capacityExceedsRatioMessage(capacity, ratio)` produces the
   same string the `classes_consistency` trigger raises, so the
   action-layer error and a DB-layer error are indistinguishable
   to the operator. Defence in depth without a UX seam.

## What's deferred

- **CSV import for students.** The `/onboarding/import` page is
  a stub; only the "Finish setup" affordance is wired. The seam
  for the real importer is the page's body — drop a
  `<StudentsCsvImport />` component in and add a parsing
  action; the wizard plumbing already advances on completion.
- **`expiresAt` enforcement on pending invitations.** The column
  is in the schema and the repo accepts it, but no scheduled
  worker flips `pending → expired` and no UI surfaces an expiry
  countdown. Clerk's invitation TTL is the de facto truth today.
- **Operator-side bulk invite.** The Teachers step invites one
  email at a time. CSV / paste-list bulk invite is a Sprint 6+
  ask.
- **Re-send of a pending invitation.** No "resend" button — the
  operator's path is revoke + re-invite. Cheap to add later
  (Clerk has a resend endpoint).

## What Chunk 2 plugs into

Chunk 2 picks up at the dashboard side. The seams it'll find:

- `WIZARD_STEPS` is now closed at `import` — adding a post-
  onboarding gate (e.g. "did you finish billing?") goes in the
  dashboard layer, not the wizard.
- `pending_invitations` and `memberships` are both tenant-scoped
  with the same `(school_id, user_id)` shape; the dashboard's
  "Team" surface can read both via the existing repositories.
- `app_find_pending_invitations_for_email` is the only
  SECURITY DEFINER cross-tenant lookup the codebase has so far.
  Any future "this email lives across schools" surface should
  follow the same pattern (function in a migration, repo wraps
  it as a `$queryRaw`, callers run outside `withTenant`).

## Verification

```
prisma generate  ✓
prisma migrate   ✓ (20260525120000 applied)
tsc --noEmit     ✓ (no errors)
eslint           ✓ (5 pre-existing warnings, 0 errors)
vitest           358 / 359 passed

  The single failing test (tenantRouting "user with two
  memberships sees the picker") was failing on `main` before
  this chunk too — `cookies()` is called outside a request scope
  by the picker render. Confirmed by stashing this chunk's
  changes and re-running the same file: same failure. Filed as
  carry-forward; the fix is to mock `next/headers` in the test.
```

## Files touched

```
M  docs/security.md
M  prisma/schema.prisma
M  src/app/page.tsx
M  src/app/s/[schoolSlug]/onboarding/classes/page.tsx
M  src/domain/enums.ts
M  src/domain/onboarding.ts
M  src/domain/types.ts
M  src/lib/db/extensions.ts
M  src/repositories/classRepository.ts
M  tests/integration/onboardingJourney.test.ts
D  src/app/s/[schoolSlug]/onboarding/classes/_actions/skipRemainingOnboarding.ts
D  src/app/s/[schoolSlug]/onboarding/classes/_actions/submitSkipRemaining.ts
D  src/app/s/[schoolSlug]/onboarding/classes/_components/ComingSoonCard.tsx
D  src/app/s/[schoolSlug]/onboarding/classes/_components/SkipRemainingForm.tsx
A  prisma/migrations/20260525120000_add_pending_invitations_and_class_pending_teacher/migration.sql
A  src/app/s/[schoolSlug]/onboarding/classes/_actions/{addClass,archiveClass,classFields,markClassesComplete,saveClassesForm,updateClass}.ts
A  src/app/s/[schoolSlug]/onboarding/classes/_components/{ClassEditor,ClassesAccordion,ClassesList,ContinueControls}.tsx
A  src/app/s/[schoolSlug]/onboarding/teachers/{page.tsx,_actions/*,_components/*}
A  src/app/s/[schoolSlug]/onboarding/import/{page.tsx,_actions/*,_components/*}
A  src/lib/auth/resolveAcceptedInvitation.ts
A  src/repositories/{membershipRepository,pendingInvitationRepository}.ts
A  tests/integration/{addClass,assignTeacherToClass,crossTenantPendingInvitation,inviteTeacher,markClassesComplete,markImportComplete,markTeachersComplete,resolveAcceptedInvitation,revokePendingInvitation}.test.ts
```
