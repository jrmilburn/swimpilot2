import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/db/client";
import { getSchoolId } from "../lib/db/context";
import type { TenantTx } from "../lib/db/withTenant";
import type { Student, StudentSkill } from "../domain/types";
import type { SkillStatus, StudentStatus } from "../domain/enums";
import { NotFoundError } from "../lib/errors";

export type DbClient = TenantTx | typeof prisma;

export type CreateStudentInput = {
  familyId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
  medicalNotes?: string | null;
  photoUrl?: string | null;
  status?: StudentStatus;
};

export type UpdateStudentInput = Partial<{
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
  medicalNotes: string | null;
  photoUrl: string | null;
  status: StudentStatus;
  deletedAt: Date | null;
}>;

export type ListBySchoolOptions = {
  limit?: number;
  cursor?: string | null;
};

export type StudentPage = {
  items: Student[];
  nextCursor: string | null;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type StudentRow = Prisma.StudentGetPayload<Record<string, never>>;

function toStudent(row: StudentRow): Student {
  return {
    id: row.id,
    schoolId: row.schoolId,
    familyId: row.familyId,
    firstName: row.firstName,
    lastName: row.lastName,
    dateOfBirth: row.dateOfBirth,
    medicalNotes: row.medicalNotes,
    photoUrl: row.photoUrl,
    status: row.status as Student["status"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

export async function getById(
  db: DbClient,
  id: string,
): Promise<Student | null> {
  const row = await db.student.findUnique({ where: { id } });
  return row ? toStudent(row) : null;
}

export async function listByFamily(
  db: DbClient,
  familyId: string,
): Promise<Student[]> {
  // No pagination — families are small, and RLS still scopes the read.
  const rows = await db.student.findMany({
    where: { familyId },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  return rows.map(toStudent);
}

export async function listBySchool(
  db: DbClient,
  options: ListBySchoolOptions = {},
): Promise<StudentPage> {
  const limit = clampLimit(options.limit);

  const rows = await db.student.findMany({
    take: limit + 1,
    orderBy: { id: "asc" },
    ...(options.cursor
      ? { cursor: { id: options.cursor }, skip: 1 }
      : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]!.id : null;

  return {
    items: page.map(toStudent),
    nextCursor,
  };
}

export async function create(
  db: DbClient,
  input: CreateStudentInput,
): Promise<Student> {
  // schoolId is derived from the family the student is being attached to.
  // The DB-level trigger `students_school_matches_family` enforces the
  // invariant, so this lookup is the single application-side source for
  // the value rather than a check we'd otherwise have to repeat.
  //
  // Reading the family inside the same transaction means RLS scopes it:
  // if the caller hands us a familyId from a different tenant, the lookup
  // returns nothing and we throw — exactly what we want.
  const family = await db.family.findUnique({
    where: { id: input.familyId },
    select: { id: true, schoolId: true },
  });
  if (!family) {
    throw new NotFoundError(`family ${input.familyId} not found`);
  }

  const data = {
    ...input,
    schoolId: family.schoolId,
  } as unknown as Prisma.StudentCreateInput;

  const row = await db.student.create({ data });
  return toStudent(row);
}

export async function update(
  db: DbClient,
  id: string,
  input: UpdateStudentInput,
): Promise<Student> {
  const row = await db.student.update({ where: { id }, data: input });
  return toStudent(row);
}

// ---------------------------------------------------------------------------
// student_skills lives on the Student aggregate. Sprint 3 / Chunk 4 — see
// docs/architecture.md → "Domain model — Skills".
// ---------------------------------------------------------------------------

export type MarkSkillInput = {
  studentId: string;
  skillId: string;
  status: SkillStatus;
  note?: string | null;
};

type StudentSkillRow = Prisma.StudentSkillGetPayload<Record<string, never>>;

function toStudentSkill(row: StudentSkillRow): StudentSkill {
  return {
    id: row.id,
    schoolId: row.schoolId,
    studentId: row.studentId,
    skillId: row.skillId,
    status: row.status as StudentSkill["status"],
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listSkills(
  db: DbClient,
  studentId: string,
): Promise<StudentSkill[]> {
  const rows = await db.studentSkill.findMany({
    where: { studentId },
    orderBy: [{ skillId: "asc" }],
  });
  return rows.map(toStudentSkill);
}

// LEFT JOIN of skills against student_skills. Returns one row per non-archived
// skill on the level, with the student's status if a row exists or a
// synthesised `not_introduced` placeholder otherwise. Synthesised rows carry
// id = "" and epoch timestamps so callers can distinguish them from real
// rows; the typical caller (Sprint 7 progression view) renders both shapes
// the same way and only reaches for `id` when persisting an edit via
// `markSkill` — at which point a real row will be created/updated.
//
// Implemented as raw SQL because Prisma's `include` would split the read
// into two round trips (skills, then student_skills filtered to studentId)
// and the spec calls out the N students × M skills case Sprint 7 will hit.
// RLS still applies to both tables — `app.school_id` filters skills and
// student_skills inside the LEFT JOIN, so a foreign-tenant student or skill
// id returns zero rows naturally.
export async function listSkillsForLevel(
  db: DbClient,
  studentId: string,
  levelId: string,
): Promise<StudentSkill[]> {
  type Row = {
    id: string;
    school_id: string;
    student_id: string;
    skill_id: string;
    status: StudentSkill["status"];
    note: string | null;
    created_at: Date | null;
    updated_at: Date | null;
  };

  const rows = await db.$queryRaw<Row[]>`
    SELECT
      COALESCE(ss.id::text, '')                       AS id,
      s.school_id::text                               AS school_id,
      ${studentId}::text                              AS student_id,
      s.id::text                                      AS skill_id,
      COALESCE(ss.status::text, 'not_introduced')     AS status,
      ss.note                                         AS note,
      ss.created_at                                   AS created_at,
      ss.updated_at                                   AS updated_at
    FROM skills s
    LEFT JOIN student_skills ss
      ON ss.skill_id = s.id
     AND ss.student_id = ${studentId}::uuid
    WHERE s.level_id = ${levelId}::uuid
      AND s.is_archived = false
    ORDER BY s.order_index ASC, s.name ASC
  `;

  return rows.map((r) => ({
    id: r.id,
    schoolId: r.school_id,
    studentId: r.student_id,
    skillId: r.skill_id,
    status: r.status,
    note: r.note,
    createdAt: r.created_at ?? new Date(0),
    updatedAt: r.updated_at ?? new Date(0),
  }));
}

// Idempotent. Reads first and short-circuits when the stored status matches
// — teachers will tap the same skill repeatedly and we don't want every tap
// to bump updated_at / updated_by. If the row doesn't exist or the status
// differs, we upsert. The (student_id, skill_id) unique index makes the
// upsert race-safe.
//
// Note: same-status no-op intentionally ignores `note`. The audit-cost
// concern is the dominant one — flipping a note without changing the status
// is rare, and a deliberate edit can route through `update` if Sprint 7
// surfaces that case.
export async function markSkill(
  db: DbClient,
  input: MarkSkillInput,
): Promise<StudentSkill> {
  const schoolId = getSchoolId();
  if (!schoolId) {
    throw new Error(
      "studentRepository.markSkill: no schoolId in tenant context; call inside withTenant()",
    );
  }

  const existing = await db.studentSkill.findUnique({
    where: {
      studentId_skillId: {
        studentId: input.studentId,
        skillId: input.skillId,
      },
    },
  });

  if (existing && existing.status === input.status) {
    return toStudentSkill(existing);
  }

  const row = await db.studentSkill.upsert({
    where: {
      studentId_skillId: {
        studentId: input.studentId,
        skillId: input.skillId,
      },
    },
    create: {
      schoolId,
      studentId: input.studentId,
      skillId: input.skillId,
      status: input.status,
      note: input.note ?? null,
    } as unknown as Prisma.StudentSkillCreateInput,
    update: {
      status: input.status,
      ...(input.note !== undefined ? { note: input.note } : {}),
    } as Prisma.StudentSkillUpdateInput,
  });
  return toStudentSkill(row);
}
