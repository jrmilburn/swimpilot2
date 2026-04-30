import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/db/client";
import { getSchoolId } from "../lib/db/context";
import type { TenantTx } from "../lib/db/withTenant";
import type { Enrolment } from "../domain/types";
import {
  EnrolmentStatus,
  type EnrolmentFrequency,
} from "../domain/enums";
import { NotFoundError } from "../lib/errors";

export type DbClient = TenantTx | typeof prisma;

export type CreateEnrolmentInput = {
  studentId: string;
  classId: string;
  frequency: EnrolmentFrequency;
  startDate: Date;
  endDate?: Date | null;
  pauseFrom?: Date | null;
  pauseTo?: Date | null;
  notes?: string | null;
};

export type UpdateEnrolmentInput = Partial<{
  frequency: EnrolmentFrequency;
  startDate: Date;
  endDate: Date | null;
  pauseFrom: Date | null;
  pauseTo: Date | null;
  status: EnrolmentStatus;
  notes: string | null;
  deletedAt: Date | null;
}>;

export type ListBySchoolOptions = {
  limit?: number;
  cursor?: string | null;
  status?: EnrolmentStatus;
};

export type EnrolmentPage = {
  items: Enrolment[];
  nextCursor: string | null;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type EnrolmentRow = Prisma.EnrolmentGetPayload<Record<string, never>>;

function toEnrolment(row: EnrolmentRow): Enrolment {
  return {
    id: row.id,
    schoolId: row.schoolId,
    studentId: row.studentId,
    classId: row.classId,
    frequency: row.frequency as Enrolment["frequency"],
    startDate: row.startDate,
    endDate: row.endDate,
    pauseFrom: row.pauseFrom,
    pauseTo: row.pauseTo,
    status: row.status as Enrolment["status"],
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

// Status is denormalised state derived from dates (the dates are the source
// of truth). On create, the application picks the right status from the
// input — the DB only enforces structural shape (paused implies pause dates
// are set; no `now()` check). Subsequent transitions go through pause /
// resume / withdraw.
function deriveCreateStatus(input: CreateEnrolmentInput, today: Date): EnrolmentStatus {
  if (input.pauseFrom && input.pauseTo) {
    const t = today.getTime();
    if (t >= input.pauseFrom.getTime() && t <= input.pauseTo.getTime()) {
      return EnrolmentStatus.Paused;
    }
  }
  return EnrolmentStatus.Active;
}

export async function getById(
  db: DbClient,
  id: string,
): Promise<Enrolment | null> {
  const row = await db.enrolment.findUnique({ where: { id } });
  return row ? toEnrolment(row) : null;
}

export async function listByStudent(
  db: DbClient,
  studentId: string,
): Promise<Enrolment[]> {
  const rows = await db.enrolment.findMany({
    where: { studentId },
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
  });
  return rows.map(toEnrolment);
}

export async function listByClass(
  db: DbClient,
  classId: string,
  options: { activeOnly?: boolean } = {},
): Promise<Enrolment[]> {
  const where: Prisma.EnrolmentWhereInput = { classId };
  if (options.activeOnly) {
    where.status = EnrolmentStatus.Active;
  }
  const rows = await db.enrolment.findMany({
    where,
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
  });
  return rows.map(toEnrolment);
}

export async function listBySchool(
  db: DbClient,
  options: ListBySchoolOptions = {},
): Promise<EnrolmentPage> {
  const limit = clampLimit(options.limit);
  const where: Prisma.EnrolmentWhereInput = {};
  if (options.status) where.status = options.status;

  const rows = await db.enrolment.findMany({
    where,
    take: limit + 1,
    orderBy: { id: "asc" },
    ...(options.cursor
      ? { cursor: { id: options.cursor }, skip: 1 }
      : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]!.id : null;

  return { items: page.map(toEnrolment), nextCursor };
}

export async function create(
  db: DbClient,
  input: CreateEnrolmentInput,
): Promise<Enrolment> {
  // schoolId is derived from the student. The DB-level trigger
  // `enrolments_consistency` enforces school_id equality between enrolment,
  // student, and class — this lookup is just the application source for the
  // value. RLS scopes the lookup, so a cross-tenant studentId returns
  // nothing and we throw, matching the studentRepository pattern.
  const tenantSchoolId = getSchoolId();
  if (!tenantSchoolId) {
    throw new Error(
      "enrolmentRepository.create: no schoolId in tenant context; call inside withTenant()",
    );
  }
  const student = await db.student.findUnique({
    where: { id: input.studentId },
    select: { id: true, schoolId: true },
  });
  if (!student) {
    throw new NotFoundError(`student ${input.studentId} not found`);
  }

  const status = deriveCreateStatus(input, new Date());
  const data = {
    schoolId: student.schoolId,
    studentId: input.studentId,
    classId: input.classId,
    frequency: input.frequency,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
    pauseFrom: input.pauseFrom ?? null,
    pauseTo: input.pauseTo ?? null,
    status,
    notes: input.notes ?? null,
  } as unknown as Prisma.EnrolmentCreateInput;

  const row = await db.enrolment.create({ data });
  return toEnrolment(row);
}

export async function update(
  db: DbClient,
  id: string,
  input: UpdateEnrolmentInput,
): Promise<Enrolment> {
  const row = await db.enrolment.update({
    where: { id },
    data: input as Prisma.EnrolmentUpdateInput,
  });
  return toEnrolment(row);
}

export async function withdraw(
  db: DbClient,
  id: string,
  endDate: Date,
): Promise<Enrolment> {
  // Convenience wrapper. Sprint 8 may add side effects here (credit refunds,
  // notifications) — keep callers out of those decisions by routing through
  // this method rather than calling `update` with the same fields.
  const row = await db.enrolment.update({
    where: { id },
    data: { status: EnrolmentStatus.Withdrawn, endDate },
  });
  return toEnrolment(row);
}

export async function pause(
  db: DbClient,
  id: string,
  from: Date,
  to: Date,
): Promise<Enrolment> {
  const row = await db.enrolment.update({
    where: { id },
    data: {
      pauseFrom: from,
      pauseTo: to,
      status: EnrolmentStatus.Paused,
    },
  });
  return toEnrolment(row);
}

export async function resume(
  db: DbClient,
  id: string,
): Promise<Enrolment> {
  // Idempotent: clearing pause dates and setting status=active works whether
  // or not the enrolment is currently paused.
  const row = await db.enrolment.update({
    where: { id },
    data: {
      pauseFrom: null,
      pauseTo: null,
      status: EnrolmentStatus.Active,
    },
  });
  return toEnrolment(row);
}
