import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/db/client";
import type { TenantTx } from "../lib/db/withTenant";
import type { ClassSession } from "../domain/types";
import { ClassSessionStatus } from "../domain/enums";
import { NotFoundError } from "../lib/errors";

export type DbClient = TenantTx | typeof prisma;

type ClassSessionRow = Prisma.ClassSessionGetPayload<Record<string, never>>;

function toClassSession(row: ClassSessionRow): ClassSession {
  return {
    id: row.id,
    schoolId: row.schoolId,
    classId: row.classId,
    sessionDate: row.sessionDate,
    teacherId: row.teacherId,
    status: row.status as ClassSession["status"],
    cancellationReason: row.cancellationReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getById(
  db: DbClient,
  id: string,
): Promise<ClassSession | null> {
  const row = await db.classSession.findUnique({ where: { id } });
  return row ? toClassSession(row) : null;
}

export async function listByClass(
  db: DbClient,
  classId: string,
  range: { from: Date; to: Date },
): Promise<ClassSession[]> {
  // Returns only existing sessions — we never materialise here. Callers
  // that need the *expected* schedule (including dates that have no row
  // yet) compose `expandEnrolmentDates` with this list.
  const rows = await db.classSession.findMany({
    where: {
      classId,
      sessionDate: { gte: range.from, lte: range.to },
    },
    orderBy: { sessionDate: "asc" },
  });
  return rows.map(toClassSession);
}

/**
 * Lazily materialise (or return) a session row for `(classId, sessionDate)`.
 *
 * The only writer of `class_sessions` rows. Idempotent via the unique
 * `(class_id, session_date)` constraint: a concurrent caller will lose the
 * race on insert and the catch path falls through to the second SELECT.
 *
 * On creation, snapshots the class's current `teacher_id` and `school_id`
 * onto the session row. Once written, the session row is the historical
 * record — reassigning the class's teacher does not propagate. Sprint 6
 * substitute-teacher flow will own overriding the snapshot.
 */
export async function getOrCreateSession(
  db: DbClient,
  classId: string,
  sessionDate: Date,
): Promise<ClassSession> {
  const existing = await db.classSession.findUnique({
    where: { classId_sessionDate: { classId, sessionDate } },
  });
  if (existing) return toClassSession(existing);

  const klass = await db.class.findUnique({
    where: { id: classId },
    select: { id: true, schoolId: true, teacherId: true },
  });
  if (!klass) {
    throw new NotFoundError(`class ${classId} not found`);
  }

  try {
    const row = await db.classSession.create({
      data: {
        schoolId: klass.schoolId,
        classId,
        sessionDate,
        teacherId: klass.teacherId,
      } as unknown as Prisma.ClassSessionCreateInput,
    });
    return toClassSession(row);
  } catch (err) {
    // Concurrent caller won the race — the unique (class_id, session_date)
    // index makes the second insert collide, and we can safely re-read.
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "P2002"
    ) {
      const row = await db.classSession.findUnique({
        where: { classId_sessionDate: { classId, sessionDate } },
      });
      if (row) return toClassSession(row);
    }
    throw err;
  }
}

export async function cancel(
  db: DbClient,
  id: string,
  reason: string,
): Promise<ClassSession> {
  // No makeup-credit side effects this chunk — Sprint 8 owns credits.
  const row = await db.classSession.update({
    where: { id },
    data: {
      status: ClassSessionStatus.Cancelled,
      cancellationReason: reason,
    },
  });
  return toClassSession(row);
}

export async function markCompleted(
  db: DbClient,
  id: string,
): Promise<ClassSession> {
  const row = await db.classSession.update({
    where: { id },
    data: { status: ClassSessionStatus.Completed },
  });
  return toClassSession(row);
}
