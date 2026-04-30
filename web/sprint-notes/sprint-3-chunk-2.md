# Sprint 3 / Chunk 2 — handoff

## What landed

- `class_levels` and `classes` tables, RLS-scoped by `app.school_id`,
  audit fields auto-populated by the existing extension.
- Migration `20260430110000_add_class_levels_and_classes`.
- Domain types `ClassLevel`, `Class` and enums `ClassStatus`, `WeekDay`.
- `classLevelRepository` (`getById`, `listBySchool`, `create`, `update`)
  and `classRepository` (`getById`, `listBySchool`, `listByLocation`,
  `listByLevel`, `create`, `update`).
- 6 integration test files (24 tests) — happy paths, cross-tenant
  isolation for both tables, three consistency scenarios, capacity vs
  ratio, soft-deleted membership rejection.
- Seed extended with locations, teacher users + memberships, 4 levels
  per school (Riverside: Infants/Beginner/Intermediate/Advanced;
  Coastal: Infants/Beginner/Intermediate/Pre-Squad), 6 classes per
  school. Idempotent on rerun (verified).
- Architecture doc updated with the wall-clock-time decision, the
  single-teacher MVP rationale, the bundled consistency trigger, and
  the capacity-≤-ratio enforcement note.

## Decisions made (not fully specced)

### Single bundled `classes_consistency` trigger

The spec described three checks (location, level, teacher-membership)
plus the capacity/ratio constraint. I bundled all four into one
`BEFORE INSERT OR UPDATE OF ...` trigger function rather than four
separate ones. Reasons:

1. Looking up `class_levels` is already needed for the school-match
   check, so the ratio comparison piggybacks for free.
2. A single function keeps execution order deterministic and the
   surface area small (one SECURITY DEFINER body to audit).
3. Mirrors the `students_school_matches_family` shape from Chunk 1 —
   one function, SECURITY DEFINER, narrow body, `check_violation`
   ERRCODE on divergence.

The trigger's `OF` column list is `school_id, location_id, level_id,
teacher_id, capacity` — these are the only columns whose change can
invalidate the invariants. Day/time/duration changes don't fire it.

### `capacity ≤ level.ratio` enforced in the trigger, not in the repo

Per the spec's "DB-layer is preferred" guidance. The repo doesn't
repeat the check. One asymmetry to flag: the trigger fires on writes
to `classes`, not on writes to `class_levels`. If an operator lowers a
level's ratio below an existing class's capacity, the lower-ratio
write succeeds and the inconsistency is only caught on the next write
to that class. Sprint 6's schedule editor will need to surface "this
will leave N classes over-capacity" before allowing the ratio
reduction. Not enforced at the DB layer because the alternative (a
trigger on `class_levels.ratio` updates that scans `classes`) trades
write throughput for an invariant that's only meaningful in
operator-driven scenarios — Sprint 6 owns it.

### Wall-clock storage as Postgres `time`, no Prisma weirdness

`@db.Time(0)` maps to Prisma `DateTime`. Round-tripping through Prisma
gave a JS Date anchored at `1970-01-01 UTC` — straightforward to
convert to/from `'HH:MM:SS'` at the repo boundary (`timeToString` /
`stringToTime` in `classRepository.ts`). No silent fallback to
`timestamp`.

### Teacher membership check: existence only, no role gate

The trigger checks "a row exists in `memberships` with `(school_id,
user_id)` matching and `deleted_at IS NULL`." Role is not checked —
role-based authz is parking-lot from Sprint 2. When that lands,
restricting "who can be assigned as a teacher" is an application-layer
concern (the trigger continues to enforce membership-exists; the role
gate sits in the action that calls `classRepository.update`).

### `teacher_id` nullable, no audit-extension surprises

The audit-fields extension stamps `created_by` / `updated_by` on every
write — including writes that set `teacherId: null`. Verified by the
"teacher can be unset (null) on update" test in `classes.test.ts`.
The extension treats `teacher_id` like any other column; it doesn't
care that it's nullable.

### Seed had no locations, users, or memberships before this chunk

To attach classes to teachers and locations, the seed needed both —
they didn't exist after Chunk 1. Added:

- 2 locations per school (`Parramatta Pool`/`Ryde Aquatic` for
  Riverside; `Bondi Pavilion`/`Maroubra Beach Pool` for Coastal),
  matched on `(school_id, name)` — no unique index, hand-rolled
  find-or-insert.
- 2 teacher users per school with `teacher` memberships, matched on
  the unique `users.email` and the `(school_id, user_id)` membership
  unique constraint.
- 4 class levels per school, idempotent via the new
  `(school_id, name)` unique index — straightforward
  `INSERT ... ON CONFLICT`.
- 6 classes per school, matched on
  `(school_id, location_id, level_id, day_of_week, start_time)`. No
  unique index there (would be reasonable but isn't a hard rule —
  multiple classes at the same level/location/day/time would be a
  scheduling error and the spec didn't mandate it). Hand-rolled
  find-or-insert; updates patch teacher / capacity / duration.

Coastal varies the ratio mix (Beginner 5, Intermediate 7, Pre-Squad 6
with a 90% progression threshold) so the two schools' frameworks are
visibly independent rather than a copy-paste template.

## Things flagged for the next chunk / future sprints

- **Ratio reduction asymmetry** (above): Chunk 6 schedule editing
  needs to warn before allowing `class_levels.ratio` to drop below an
  existing class's capacity.
- **Conflict detection**: nothing prevents double-booking a teacher
  across overlapping classes today. Sprint 6 owns this — flagged in
  the spec's Out-of-scope list, just confirming it remains open.
- **Class identity uniqueness**: a `(school_id, location_id, level_id,
  day_of_week, start_time)` unique index would prevent duplicate
  recurring slots. Not added because the spec didn't require it and a
  failed unique-constraint error from operator double-clicks isn't
  necessarily friendlier than a soft warning at the action layer.
  Sprint 6 should decide.
- **`class_sessions` design**: Chunk 3 owns the materialise-rolling-N-
  weeks vs generate-on-demand call. The wall-clock-time decision here
  means session instants will need to combine `class.start_time` +
  `location.timezone` + a date — straightforward but document the
  helper that does it so it isn't reimplemented.
- **Soft-deleted memberships**: the trigger correctly rejects assigning
  a teacher whose membership has `deleted_at` set. We don't currently
  cascade-clear `class.teacher_id` when a membership is soft-deleted
  — future writes to those classes will fail the trigger. Membership
  deactivation flow (later sprint) should null out the teacher_id of
  any classes assigned to that user.

## Pattern discoveries (now in `docs/architecture.md`)

- The DB-layer-trigger pattern is now used for four invariants. The
  doc has a generalisation note so Chunk 3+ can reach for the same
  shape (BEFORE INSERT/UPDATE, SECURITY DEFINER, narrow body, raise
  with `ERRCODE = 'check_violation'`).
- Wall-clock-time-as-string at the domain boundary is a reusable
  pattern — the repository owns conversion to/from the Postgres
  `time` type. If `class_sessions` introduces a date-time pair (date
  + wall-clock time + timezone), the same shape applies: keep the
  domain type unambiguous, do the conversion in the repository.
