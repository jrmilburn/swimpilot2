# Sprint 3 / Chunk 3 — handoff

## What landed

- `enrolments`, `class_sessions`, `attendance` tables — RLS-scoped by
  `app.school_id`, audit fields auto-populated by the existing
  extension, three SECURITY DEFINER consistency triggers
  (`enrolments_consistency`, `class_sessions_consistency`,
  `attendance_consistency`).
- Migration `20260430120000_add_enrolments_sessions_attendance`.
- Domain enums `EnrolmentFrequency`, `EnrolmentStatus`,
  `ClassSessionStatus`, `AttendanceStatus`. Domain types `Enrolment`,
  `ClassSession`, `AttendanceRecord`.
- Pure date-expansion function `expandEnrolmentDates` in
  `src/domain/enrolment.ts` — no DB access, no `now()`, fully
  unit-tested (10 cases covering all four frequencies plus pause
  windows, end_date short-circuit, range start-after-startDate).
- Three repositories: `enrolmentRepository` (CRUD + pause / resume /
  withdraw), `classSessionRepository` (`getOrCreateSession` is the only
  writer; `cancel`, `markCompleted`, `listByClass`),
  `attendanceRepository` (`mark` is an upsert with cancelled-session
  guard, `listBySession`, `listByStudent`).
- 9 integration test files plus the one unit test file. Coverage
  spans: happy paths for each repo, the four enrolment CHECK
  constraints, the day-of-week trigger, the four legs of the
  attendance consistency trigger, and per-table cross-tenant
  isolation.
- Seed extended with 13 enrolments for Riverside and 12 for Coastal,
  spanning all four frequencies plus paused and withdrawn statuses.
  Recent sessions for the last six weeks are materialised through
  `getOrCreateSession`, attendance marks follow a deterministic
  `[present, present, present, present, late, present, absent,
  present]` cycle so seeded data is stable for tests and demos.
  Verified idempotent on rerun (25 enrolments, 24 sessions, 34
  attendance both runs).
- `docs/architecture.md` extended with a "Domain model — Enrolments
  and sessions" section covering the structural-only invariants, the
  status-vs-dates rationale, lazy materialisation, teacher
  snapshotting, the cancelled-session guard, and the purity
  requirement on `expandEnrolmentDates`.

## Decisions made (not fully specced)

### Status is denormalised; DB enforces only structural shape

The spec asked for `status` on enrolments. I treated it as a
denormalised projection of the date columns (start / end / pause
window) rather than the source of truth. The DB enforces the
structural invariants — pause-both-or-neither, pause window
ordering, end >= start, one_off ⇒ end = start, paused ⇒ pause_from
not null — but **does not** check `now()` against the pause window or
end_date.

Two reasons. First, `now()`-dependent CHECK constraints break tests
that need to time-travel and break backdated edits (admins fixing a
historical mark). Second, the application owns transitions anyway via
explicit `pause` / `resume` / `withdraw` repository methods that set
both the dates and the matching status atomically. The structural
constraints catch anyone half-writing the pair.

This means an active row whose end_date is in the past is technically
valid in the DB. That's intentional — the calendar shifts under us;
the row is still a faithful record of "this enrolment ran from X to
Y." `expandEnrolmentDates` filters on dates, so query callers see the
right thing.

### Teacher snapshot frozen at session creation

`class_sessions.teacher_id` is set from `class.teacher_id` at the
moment `getOrCreateSession` writes the row, and never re-derived.
Reassigning the class's teacher does not propagate. The
`classSessions.test.ts` "teacher snapshot is frozen" test pins this
behaviour.

The substitute-teacher flow (Sprint 6) will own writing to
`class_sessions.teacher_id` directly. At that point, the session row
is the single load-bearing source for "who taught this." The current
class-level `teacher_id` becomes "the default for sessions we haven't
materialised yet."

A consequence to watch in seeds and backfills: if you ever build a
batch tool that materialises sessions for past dates, it'll capture
*the current teacher*, not the historical one. There is no way to
recover the historical teacher from the class row alone. If that
matters later, the fix is to write the session with the right teacher
at create time — once the row exists, the snapshot is frozen.

### Auto-completion of sessions: not on the write path

The spec mentioned the option of auto-completing a session when all
enrolled students are marked. I deliberately did **not** wire this up.
Doing it on every `mark` call would force each upsert to lock and
re-read the enrolment list and the existing attendance rows for that
session — undoing the small-write benefit of an upsert and making
concurrent marking a contention hotspot.

Manual `markCompleted` is a separate, explicit action. The roster UI
in Sprint 5/6 can call it once after the user finishes marking, or run
a periodic sweep. If we eventually want automatic completion, the
right shape is a deferred trigger / advisory queue, not inline.

### Cancelled-session guard is application-layer, not a DB CHECK

`attendanceRepository.mark` reads the parent session first and throws
`ValidationError` if it's `cancelled`. I did not encode this as a DB
CHECK because:

- It's a domain semantic ("this session didn't happen, so attendance
  against it is meaningless"), not a structural invariant. UIs want to
  surface it as a recoverable user error, not a 500.
- A CHECK on `attendance` referencing `class_sessions.status` would
  need a trigger anyway (CHECKs can't subquery), and we already have
  the trigger budget consumed by the consistency checks.
- `ValidationError` is part of the typed error contract the
  `tenantAction` wrapper maps to a `VALIDATION` result code — the UI
  pathway is already wired.

### `expandEnrolmentDates` is pure; the seed inlines a mirror

`expandEnrolmentDates` is in `/domain/enrolment.ts` and has zero
dependencies on the DB or the wall clock. The seed needed almost the
same logic to compute "qualifies on date X for backfill" but seeds
import-cycle through `@prisma/client`, and the domain layer is meant
to stay free of seed/test boilerplate. I inlined a small
`qualifiesOnDate` helper inside `seed.ts` that mirrors the function's
parity logic. If the rule ever changes, both must move together —
flagging that explicitly here so a future change doesn't quietly drift
the two.

### Constraint error matchers in the integration tests

The DB-level CHECK constraints have predictable names
(`enrolments_pause_both_or_neither_check`, etc.), so the constraint
tests grep for those names in the thrown error message. The trigger
errors raise with `ERRCODE = 'check_violation'` and the message is
`'<table>.<col> (%) must match …'` — tests grep on the message. This
matches the pattern set in Chunk 2's `classConsistency.test.ts`.

## Things to know for the next chunk

- `getOrCreateSession` is the **only** writer to `class_sessions`. New
  callers that need a session row should always go through it; never
  call `tx.classSession.create` directly. The day-of-week trigger and
  the unique `(class_id, session_date)` index make direct inserts
  fragile.
- `expandEnrolmentDates` is the seam roster generation, schedule UIs,
  and "next session for student X" all share. Keep it pure. If you
  find yourself wanting to add a DB call or read the wall clock from
  inside it, that decision belongs in the caller — pass the date
  range in.
- Attendance is keyed on `(class_session_id, student_id)`, not
  `(class_session_id, enrolment_id)`. If a student moves between
  enrolments mid-term (e.g., switching from weekly to fortnightly),
  the existing attendance row's `enrolment_id` becomes stale. Sprint
  6/8 should decide whether to backfill or to treat the rows as
  historical.
- The seed snaps enrolment `start_date` to the class's day-of-week.
  `2026-04-01` is a Wednesday in our test suite — that anchor is used
  across `enrolments.test.ts`, `classSessions.test.ts`, and the
  cross-tenant tests. Don't move it without sweeping the test files.
- The `class_sessions_consistency` trigger lists `school_id, class_id,
  session_date` in its `OF` column list. Updates to `teacher_id`,
  `status`, or `cancellation_reason` do not refire it — that's
  deliberate so substitute-teacher updates (Sprint 6) won't trip it.

## Things deliberately deferred

- Makeup-credit ledger. `withdraw` and `cancel` could plausibly emit
  credits. Sprint 8 owns the credit model — those repository methods
  are already typed as the seam where the side effect will land, so
  callers don't need to change.
- Mark history / audit. `mark` is an upsert; we keep only the latest
  value plus the audit-fields stamp of who flipped it. If a fuller
  history is needed, add a `attendance_events` append-only table
  rather than mutating this contract.
- Substitute-teacher overrides. Reassigning a session's teacher is a
  bare `tx.classSession.update` today — fine for the cancelled flow,
  not enough for substitute UX. Sprint 6 will add the proper
  repository method and audit trail.
- Status auto-recomputation on date edits. If an admin edits an
  enrolment's pause window from "future" to "now", `status` won't flip
  to `paused` automatically. Sprint 6's enrolment editor will own
  recomputing status alongside the date edit.
