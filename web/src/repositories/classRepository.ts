import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/db/client";
import { getSchoolId } from "../lib/db/context";
import type { TenantTx } from "../lib/db/withTenant";
import type { Class } from "../domain/types";
import type { ClassStatus, WeekDay } from "../domain/enums";

export type DbClient = TenantTx | typeof prisma;

export type CreateClassInput = {
  locationId: string;
  levelId: string;
  teacherId?: string | null;
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
  return row ? toClass(row) : null;
}

export async function listBySchool(
  db: DbClient,
  options: ListBySchoolOptions = {},
): Promise<ClassPage> {
  const limit = clampLimit(options.limit);

  const rows = await db.class.findMany({
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
    where: { locationId },
    orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
  });
  return rows.map(toClass);
}

export async function listByLevel(
  db: DbClient,
  levelId: string,
): Promise<Class[]> {
  const rows = await db.class.findMany({
    where: { levelId },
    orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
  });
  return rows.map(toClass);
}

export async function create(
  db: DbClient,
  input: CreateClassInput,
): Promise<Class> {
  // schoolId comes from tenant context. The DB-level trigger
  // `classes_consistency` enforces school_id equality with location and
  // level, capacity ≤ level.ratio, and (if set) teacher_id membership.
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
  const row = await db.class.create({ data });
  return toClass(row);
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
  const row = await db.class.update({
    where: { id },
    data: data as Prisma.ClassUpdateInput,
  });
  return toClass(row);
}
