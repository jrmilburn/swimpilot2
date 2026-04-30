import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/db/client";
import { getSchoolId } from "../lib/db/context";
import type { TenantTx } from "../lib/db/withTenant";
import type { ClassLevel } from "../domain/types";

export type DbClient = TenantTx | typeof prisma;

export type CreateClassLevelInput = {
  name: string;
  description?: string | null;
  ratio: number;
  orderIndex: number;
  minAgeMonths?: number | null;
  maxAgeMonths?: number | null;
  defaultProgressionThreshold?: number;
};

export type UpdateClassLevelInput = Partial<{
  name: string;
  description: string | null;
  ratio: number;
  orderIndex: number;
  minAgeMonths: number | null;
  maxAgeMonths: number | null;
  defaultProgressionThreshold: number;
  deletedAt: Date | null;
}>;

type ClassLevelRow = Prisma.ClassLevelGetPayload<Record<string, never>>;

function toClassLevel(row: ClassLevelRow): ClassLevel {
  return {
    id: row.id,
    schoolId: row.schoolId,
    name: row.name,
    description: row.description,
    ratio: row.ratio,
    orderIndex: row.orderIndex,
    minAgeMonths: row.minAgeMonths,
    maxAgeMonths: row.maxAgeMonths,
    defaultProgressionThreshold: row.defaultProgressionThreshold,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getById(
  db: DbClient,
  id: string,
): Promise<ClassLevel | null> {
  const row = await db.classLevel.findUnique({ where: { id } });
  return row ? toClassLevel(row) : null;
}

export async function listBySchool(db: DbClient): Promise<ClassLevel[]> {
  // No pagination — a school will have a small set of levels in practice.
  // RLS scopes the read to the current tenant.
  const rows = await db.classLevel.findMany({
    orderBy: [{ orderIndex: "asc" }, { name: "asc" }],
  });
  return rows.map(toClassLevel);
}

export async function create(
  db: DbClient,
  input: CreateClassLevelInput,
): Promise<ClassLevel> {
  // schoolId comes from the AsyncLocalStorage tenant context (the same
  // context withTenant populates) — never from the caller. RLS WITH CHECK
  // would refuse a write that disagreed with app.school_id anyway.
  const schoolId = getSchoolId();
  if (!schoolId) {
    throw new Error(
      "classLevelRepository.create: no schoolId in tenant context; call inside withTenant()",
    );
  }

  const data = {
    ...input,
    schoolId,
  } as unknown as Prisma.ClassLevelCreateInput;
  const row = await db.classLevel.create({ data });
  return toClassLevel(row);
}

export async function update(
  db: DbClient,
  id: string,
  input: UpdateClassLevelInput,
): Promise<ClassLevel> {
  const row = await db.classLevel.update({ where: { id }, data: input });
  return toClassLevel(row);
}
