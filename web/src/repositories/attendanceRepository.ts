import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/db/client";
import { getSchoolId } from "../lib/db/context";
import type { TenantTx } from "../lib/db/withTenant";
import type { AttendanceRecord } from "../domain/types";
import { AttendanceStatus, ClassSessionStatus } from "../domain/enums";
import { NotFoundError, ValidationError } from "../lib/errors";

export type DbClient = TenantTx | typeof prisma;

export type MarkAttendanceInput = {
  classSessionId: string;
  enrolmentId: string;
  studentId: string;
  status: AttendanceStatus;
  note?: string | null;
};

type AttendanceRow = Prisma.AttendanceGetPayload<Record<string, never>>;

function toAttendance(row: AttendanceRow): AttendanceRecord {
  return {
    id: row.id,
    schoolId: row.schoolId,
    classSessionId: row.classSessionId,
    enrolmentId: row.enrolmentId,
    studentId: row.studentId,
    status: row.status as AttendanceRecord["status"],
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getById(
  db: DbClient,
  id: string,
): Promise<AttendanceRecord | null> {
  const row = await db.attendance.findUnique({ where: { id } });
  return row ? toAttendance(row) : null;
}

export async function listBySession(
  db: DbClient,
  classSessionId: string,
): Promise<AttendanceRecord[]> {
  const rows = await db.attendance.findMany({
    where: { classSessionId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toAttendance);
}

export async function listByStudent(
  db: DbClient,
  studentId: string,
  range?: { from: Date; to: Date },
): Promise<AttendanceRecord[]> {
  // Range is optional — when present, filter by the parent session's date
  // (attendance rows themselves have no calendar date). RLS scopes the
  // join automatically.
  const where: Prisma.AttendanceWhereInput = { studentId };
  if (range) {
    where.classSession = { sessionDate: { gte: range.from, lte: range.to } };
  }
  const rows = await db.attendance.findMany({
    where,
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toAttendance);
}

/**
 * Upsert an attendance record on `(class_session_id, student_id)`.
 *
 * Looks up the parent session first to enforce that it isn't `cancelled` —
 * marking attendance against a cancelled session is a domain error, not a
 * database error, so we surface a typed `ValidationError`.
 *
 * Auto-completion of the session is intentionally *not* done here. See
 * sprint-notes/sprint-3-chunk-3.md for why — manual `markCompleted` keeps
 * the write small and avoids extra locking under concurrent marks.
 */
export async function mark(
  db: DbClient,
  input: MarkAttendanceInput,
): Promise<AttendanceRecord> {
  const tenantSchoolId = getSchoolId();
  if (!tenantSchoolId) {
    throw new Error(
      "attendanceRepository.mark: no schoolId in tenant context; call inside withTenant()",
    );
  }

  const session = await db.classSession.findUnique({
    where: { id: input.classSessionId },
    select: { id: true, schoolId: true, status: true },
  });
  if (!session) {
    throw new NotFoundError(`class session ${input.classSessionId} not found`);
  }
  if (session.status === ClassSessionStatus.Cancelled) {
    throw new ValidationError(
      `cannot mark attendance on cancelled session ${input.classSessionId}`,
    );
  }

  const baseData = {
    schoolId: session.schoolId,
    classSessionId: input.classSessionId,
    enrolmentId: input.enrolmentId,
    studentId: input.studentId,
    status: input.status,
    note: input.note ?? null,
  };

  const row = await db.attendance.upsert({
    where: {
      classSessionId_studentId: {
        classSessionId: input.classSessionId,
        studentId: input.studentId,
      },
    },
    create: baseData as unknown as Prisma.AttendanceCreateInput,
    update: {
      status: input.status,
      note: input.note ?? null,
      enrolmentId: input.enrolmentId,
    },
  });
  return toAttendance(row);
}
