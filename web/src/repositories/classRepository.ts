import { Prisma } from "@prisma/client";
import { prisma } from "../lib/db/client";
import { getSchoolId } from "../lib/db/context";
import type { TenantTx } from "../lib/db/withTenant";
import type { Class } from "../domain/types";
import type { ClassStatus, WeekDay } from "../domain/enums";
import { ValidationError } from "../lib/errors";

export type DbClient = TenantTx | typeof prisma;

export type CreateClassInput = {
  locationId: string;
  levelId: string;
  teacherId?: string | null;
  pendingTeacherInvitationId?: string | null;
  dayOfWeek: WeekDay;
  startTime: string; // 'HH:MM' or 'HH:MM:SS' wall-clock
  durationMinutes: number;
  capacity: number;
  status?: ClassStatus;
};

export type UpdateClassInput = Partial<{
  locationId: string;
  levelId: string;
  teacherId: string | null;
  pendingTeacherInvitationId: string | null;
  dayOfWeek: WeekDay;
  startTime: string;
  durationMinutes: number;
  capacity: number;
  status: ClassStatus;
  deletedAt: Date | null;
}>;

export type ListBySchoolOptions = {
  limit?: number;
  cursor?: string | null;
  includeArchived?: boolean;
};

export type ClassPage = {
  items: Class[];
  nextCursor: string | null;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type ClassRow = Prisma.ClassGetPayload<Record<string, never>>;

// Postgres `time` round-trips through Prisma as a JS Date anchored at
// 1970-01-01 UTC. We strip back to a 'HH:MM:SS' string at the repository
// boundary so the domain type stays unambiguous wall-clock — a Date would
// imply a calendar instant, which a recurring class is explicitly not.
function timeToString(value: Date): string {
  return value.toISOString().slice(11, 19);
}

function stringToTime(value: string): Date {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) {
    throw new Error(
      `Invalid HH:MM[:SS] time string for Class.startTime: ${value}`,
    );
  }
  const [, hh, mm, ss = "00"] = m;
  return new Date(`1970-01-01T${hh}:${mm}:${ss}Z`);
}

function toClass(row: ClassRow): Class {
  return {
    id: row.id,
    schoolId: row.schoolId,
    locationId: row.locationId,
    levelId: row.levelId,
    teacherId: row.teacherId,
    pendingTeacherInvitationId: row.pendingTeacherInvitationId,
    dayOfWeek: row.dayOfWeek as Class["dayOfWeek"],
    startTime: timeToString(row.startTime),
    durationMinutes: row.durationMinutes,
    capacity: row.capacity,
    status: row.status as Class["status"],
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
): Promise<Class | null> {
  const row = await db.class.findUnique({ where: { id } });
  if (!row) return null;
  // Soft-deleted rows are visible to RLS but should be invisible to
  // wizard / dashboard callers. Mirror the locations / levels pattern.
  if (row.deletedAt) return null;
  return toClass(row);
}

export async function listBySchool(
  db: DbClient,
  options: ListBySchoolOptions = {},
): Promise<ClassPage> {
  const limit = clampLimit(options.limit);

  const where: Prisma.ClassWhereInput = {};
  if (!options.includeArchived) where.deletedAt = null;

  const rows = await db.class.findMany({
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

  return { items: page.map(toClass), nextCursor };
}

export async function listByLocation(
  db: DbClient,
  locationId: string,
): Promise<Class[]> {
  // Native enums sort by declared order in Postgres — week_day is declared
  // monday-first, so this gives the expected Mon→Sun grid order.
  const rows = await db.class.findMany({
    where: { locationId, deletedAt: null },
    orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
  });
  return rows.map(toClass);
}

export async function listByLevel(
  db: DbClient,
  levelId: string,
): Promise<Class[]> {
  const rows = await db.class.findMany({
    where: { levelId, deletedAt: null },
    orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
  });
  return rows.map(toClass);
}

/**
 * List classes the operator hasn't yet assigned to anyone — neither a
 * real teacher nor a pending invitation. Used by the Teachers step's
 * assignment list to surface "still open" rows.
 */
export async function listUnassigned(db: DbClient): Promise<Class[]> {
  const rows = await db.class.findMany({
    where: {
      deletedAt: null,
      teacherId: null,
      pendingTeacherInvitationId: null,
    },
    orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
  });
  return rows.map(toClass);
}

// `classes` does NOT carry a unique index on
// `(school_id, location_id, day_of_week, start_time)` — see the
// Sprint 5 / Chunk 1 migration's preamble. A multi-lane pool runs
// concurrent classes at the same `(location, day, time)` slot. The
// mapper below is wired into create/update for forward-compat: if a
// future migration adds a unique index, this turns the Prisma `P2002`
// into a typed `ValidationError` and the action layer doesn't have to
// change. Today the catch is a no-op.
const PRISMA_UNIQUE_VIOLATION = "P2002";

function mapUniqueViolation(err: unknown): never {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === PRISMA_UNIQUE_VIOLATION
  ) {
    throw new ValidationError(
      "A class with the same location, day, and time already exists.",
      {
        _form:
          "A class with the same location, day, and time already exists.",
      },
    );
  }
  throw err;
}

export async function create(
  db: DbClient,
  input: CreateClassInput,
): Promise<Class> {
  // schoolId comes from tenant context. The DB-level trigger
  // `classes_consistency` enforces school_id equality with location and
  // level, capacity ≤ level.ratio, the teacher's membership, and the
  // pending invitation's school+status (Sprint 5 / Chunk 1 extension).
  const schoolId = getSchoolId();
  if (!schoolId) {
    throw new Error(
      "classRepository.create: no schoolId in tenant context; call inside withTenant()",
    );
  }

  const data = {
    ...input,
    schoolId,
    startTime: stringToTime(input.startTime),
  } as unknown as Prisma.ClassCreateInput;
  try {
    const row = await db.class.create({ data });
    return toClass(row);
  } catch (err) {
    mapUniqueViolation(err);
  }
}

export async function update(
  db: DbClient,
  id: string,
  input: UpdateClassInput,
): Promise<Class> {
  const data: Record<string, unknown> = { ...input };
  if (input.startTime !== undefined) {
    data.startTime = stringToTime(input.startTime);
  }
  try {
    const row = await db.class.update({
      where: { id },
      data: data as Prisma.ClassUpdateInput,
    });
    return toClass(row);
  } catch (err) {
    mapUniqueViolation(err);
  }
}

/**
 * Soft-delete. Sets `deleted_at = now()`. Mirrors `locationRepository`'s
 * archive: idempotent at the repository boundary (a second archive
 * replaces the timestamp). Action-layer callers that want
 * "no-op when already archived" should check `getById` first — the
 * repository hides archived rows from that read.
 */
export async function archive(db: DbClient, id: string): Promise<Class> {
  const row = await db.class.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  return toClass(row);
}

/**
 * Atomic-swap UPDATE used during sign-in-redirect invitation acceptance:
 * every class parked on `pending_teacher_invitation_id = invitationId`
 * flips onto `teacher_id = userId` in a single statement. The
 * `classes_teacher_xor_pending_check` CHECK fires on the resulting row
 * (not intermediate state) so a single UPDATE is correct.
 *
 * Returns the count of affected rows so the caller can log how many
 * classes moved onto the new teacher.
 */
export async function swapPendingInvitationToTeacher(
  db: DbClient,
  invitationId: string,
  teacherId: string,
): Promise<number> {
  const result = await db.class.updateMany({
    where: {
      pendingTeacherInvitationId: invitationId,
      deletedAt: null,
    },
    data: {
      teacherId,
      pendingTeacherInvitationId: null,
    },
  });
  return result.count;
}
