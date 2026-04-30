import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/db/client";
import type { TenantTx } from "../lib/db/withTenant";
import type { Student } from "../domain/types";
import type { StudentStatus } from "../domain/enums";
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
