# Sprint 3 / Chunk 4 — handoff

## What landed

- `skills` and `student_skills` tables — RLS-scoped on `app.school_id`,
  audit fields auto-stamped by the existing extension, two
  SECURITY DEFINER consistency triggers (`skills_consistency`,
  `student_skills_consistency`).
- Migration
  `20260501100000_add_skills_and_student_skills` — both tables, the
  `skill_status` enum (`not_introduced` / `working_on` / `achieved`),
  unique indexes on `(school_id, level_id, name)` and `(student_id,
  skill_id)`, plus a partial index `student_skills_achieved_idx WHERE
  status = 'achieved'` for the "what has this student achieved" view.
- Domain enum `SkillStatus` and domain types `Skill`, `StudentSkill`.
  Both new Prisma models added to the audit-extension `DOMAIN_MODELS`
  set so `created_by` / `updated_by` are stamped automatically.
- `skillRepository` (new): `getById`, `listByLevel`, `listBySchool`,
  `create`, `update`, `archive`, `unarchive`. `listByLevel` filters
  archived skills by default; `listBySchool` orders by level
  `order_index` then skill `order_index`.
- `studentRepository` extended with `listSkills` (per student),
  `listSkillsForLevel` (LEFT JOIN raw SQL with synthesised
  `not_introduced` placeholders), and `markSkill` (idempotent upsert
  that no-ops on same status).
- 6 integration test files: `skills.test.ts`, `studentSkills.test.ts`,
  `skillConsistency.test.ts`, `skillNameUniqueness.test.ts`,
  `crossTenantSkill.test.ts`, `crossTenantStudentSkill.test.ts`.
  Coverage spans repository CRUD, the same-status no-op invariant,
  trigger rejections, name uniqueness scoping, and per-table RLS
  isolation.
- Seed extended with the ASSA-aligned skill curriculum: 22 Riverside
  skills across four levels, 23 Coastal skills across four levels (the
  two frameworks are intentionally different to keep cross-tenant
  testing honest). 16 Riverside `student_skills` and 11 Coastal
  `student_skills` distributed across students at different points in
  their progression.
- `docs/architecture.md` extended with a "Domain model — Skills"
  section: Shape A rationale, the two consistency triggers, why
  level-reachability is *not* enforced at the DB layer, the
  same-status no-op rule, why `listSkillsForLevel` is raw SQL, and the
  soft-archive contract.

## Decisions made (not fully specced)

### Same-status `markSkill` is a no-op, ignoring `note`

`markSkill` reads first and short-circuits when the stored status
already matches the input. The motivation is teacher behaviour —
during a lesson they will tap a skill repeatedly to reassure
themselves it's set, and we don't want every tap to bump
`updated_at` / `updated_by`. The audit fields should reflect the last
*change* of state, not the last touch.

The no-op deliberately ignores `note` — flipping a note without
changing the status is rare, and conflating "I tapped this again" with
"I want to update the note" makes the contract muddy. If Sprint 7
surfaces a "edit note without status change" path, that should route
through a separate update method (`updateNote(studentId, skillId,
note)`) rather than overloading the tap interaction.

The `(student_id, skill_id)` unique index makes the upsert race-safe:
two teachers double-tapping the same skill on different devices land
on either the no-op branch or the update branch deterministically.

### Level-reachability is **not** enforced at the DB layer

The `student_skills_consistency` trigger checks
`school_id` matches across `students`, `skills`, and `student_skills`,
but does **not** check that the student is currently enrolled at the
level the skill belongs to. Two reasons:

- A student can validly carry skill marks for a level they're working
  through but not yet enrolled in (a teacher previewing them up), or
  a level they've graduated from. Both are real cases.
- Encoding "must be enrolled at this level right now" as a trigger
  pulls a moving wall-clock into the DB layer — same complaint we had
  in Chunk 3 about `now()`-dependent CHECKs. It would also force the
  trigger to walk `enrolments` for every write, which is a contention
  hotspot in the lesson-time tap path.

If a school wants the rule enforced, the right place is the
application service layer (a "save progression" UI guard), where it
can be a soft warning rather than a 500.

### `listSkillsForLevel` is raw SQL on purpose

Implemented as a single `$queryRaw` LEFT JOIN of `skills` against
`student_skills`. Prisma's `include` would split it into two round
trips (fetch skills, then student_skills filtered to the studentId,
then merge in app code). Sprint 7's progression view will hit this in
a per-student-per-class hot loop where halving the round-trip count
matters.

Synthesised rows for skills the student has no `student_skills` row
on yet carry `id: ""`, epoch dates, and `status: 'not_introduced'`.
Callers that only need to render and don't care about persistence
treat real and synthesised rows identically; callers that want to
persist an edit hand the row to `markSkill`, which writes a real row
and the next read sees its UUID. The synthesised-row contract is
documented inline on the repository function.

### `is_archived` is soft-retire, not delete

Hard-deleting a skill would break older `student_skills` rows that
reference it via FK, and would erase progression history that parents
and teachers look back on years later. Archiving keeps the row
queryable but hides it from the default `listByLevel` and
`listSkillsForLevel`. `includeArchived: true` brings them back.

The trade-off is that archived skills still occupy a slot in the
`(school_id, level_id, name)` unique index. A school that wants to
reuse a name has to unarchive or rename. That's acceptable — names
collisions across the curriculum are rare and renaming is cheap.

### `description` is text, not a structured rubric

The spec didn't mandate a shape. I kept `description` as a single
nullable `text` field rather than introducing structured fields
("teaching cue", "assessment criterion", "common error"). The intent
was to ship — schools that want structure can use Markdown today, and
if Sprint 8+ wants real structure we can add columns or a JSON
sidecar table without breaking the existing data.

### Constraint and trigger error matchers in tests

Same pattern as Chunk 3: trigger errors raise with
`ERRCODE = 'check_violation'` and a message of the form `'<table>.<col>
(%) must match …'`. Tests grep on those messages. The unique index
violations bubble through Prisma as `P2002`; tests use plain
`rejects.toThrow()` because the message text is Prisma-version
dependent.

## Things to know for the next chunk

- `markSkill` is idempotent and same-status-safe. **Do not** add a
  parallel write path that bypasses the read-first short-circuit —
  that would break the audit-field contract teachers rely on. If a
  bulk-mark workflow is needed, the right shape is a loop of
  `markSkill` calls inside a single tenant transaction; the
  short-circuit makes that cheap.
- `listSkillsForLevel` returns synthesised rows with `id: ""`. Any
  code path that persists must call `markSkill` to materialise the
  real row — never write to `student_skills` directly through Prisma
  in repository code. The audit extension and the consistency trigger
  both depend on the upsert going through the repository.
- The two seed frameworks (Riverside and Coastal) are deliberately
  different. Tests that hard-code Riverside skill names will silently
  pass on Coastal data — keep the curriculum-aware tests scoped to a
  specific school slug.
- The partial index `student_skills_achieved_idx ON (school_id,
  student_id) WHERE status = 'achieved'` is sized for the parent
  progression view. If a future caller wants "what has this *cohort*
  achieved" or "which students have *this skill* achieved," the right
  fix is a second partial index keyed differently, not loosening the
  WHERE clause.
- `skills_consistency` fires on `BEFORE INSERT OR UPDATE OF school_id,
  level_id`. Updates to `name`, `description`, `order_index`, or
  `is_archived` do not refire it — that's deliberate so the curriculum
  editor in Sprint 7 doesn't pay the trigger cost on every reorder.

## Things deliberately deferred

- **Skill events / progression history.** `student_skills` is
  Shape A — current state, mutated. If a future sprint needs a full
  history of every flip ("Mia moved from working_on → achieved on
  2026-06-12 by teacher Alice"), the right shape is a separate
  `student_skill_events` append-only table rather than mutating this
  contract. The audit fields on the row capture *who* and *when* of
  the last change; the rest is a Sprint 10+ concern.
- **Skill prerequisites / DAG.** No "achieve A before B" structure.
  The spec is flat per-level; if pedagogy demands a prerequisite
  graph later, it's an additive table reference, not a migration of
  the existing rows.
- **Bulk import / CSV upload of curricula.** Schools today hand-craft
  their list. Sprint 7 will surface the curriculum editor; bulk
  import is downstream of that.
- **Per-skill assessment criteria / rubric scoring.** Status is a
  three-state enum, not a 0–100 score or a rubric. If teachers want
  partial credit, the cleanest way is to introduce a per-skill rubric
  side table, not to widen the enum.
- **Auto-promotion when achieved% > threshold.** `class_levels` already
  carries a `default_progression_threshold`, but no automation reads
  it yet. The progression view in Sprint 7 will compute the % and
  surface a "ready to move up" hint; flipping the student's enrolment
  is a separate human-in-the-loop decision.
