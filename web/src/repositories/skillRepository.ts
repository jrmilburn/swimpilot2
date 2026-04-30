import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/db/client";
import { getSchoolId } from "../lib/db/context";
import type { TenantTx } from "../lib/db/withTenant";
import type { Skill } from "../domain/types";

export type DbClient = TenantTx | typeof prisma;

export type CreateSkillInput = {
  levelId: string;
  name: string;
  description?: string | null;
  orderIndex: number;
  isArchived?: boolean;
};

export type UpdateSkillInput = Partial<{
  name: string;
  description: string | null;
  orderIndex: number;
  isArchived: boolean;
  deletedAt: Date | null;
}>;

export type ListByLevelOptions = {
  includeArchived?: boolean;
};

export type ListBySchoolOptions = {
  includeArchived?: boolean;
};

type SkillRow = Prisma.SkillGetPayload<Record<string, never>>;

function toSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    schoolId: row.schoolId,
    levelId: row.levelId,
    name: row.name,
    description: row.description,
    orderIndex: row.orderIndex,
    isArchived: row.isArchived,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getById(
  db: DbClient,
  id: string,
): Promise<Skill | null> {
  const row = await db.skill.findUnique({ where: { id } });
  return row ? toSkill(row) : null;
}

export async function listByLevel(
  db: DbClient,
  levelId: string,
  options: ListByLevelOptions = {},
): Promise<Skill[]> {
  const where: Prisma.SkillWhereInput = { levelId };
  if (!options.includeArchived) {
    where.isArchived = false;
  }
  const rows = await db.skill.findMany({
    where,
    orderBy: [{ orderIndex: "asc" }, { name: "asc" }],
  });
  return rows.map(toSkill);
}

export async function listBySchool(
  db: DbClient,
  options: ListBySchoolOptions = {},
): Promise<Skill[]> {
  // Order by the level's order_index first, then the skill's order_index
  // within the level. Levels are small and pulled along with the skill so
  // the admin curriculum screen (Sprint 7) can render the whole framework
  // in one round trip.
  const where: Prisma.SkillWhereInput = {};
  if (!options.includeArchived) {
    where.isArchived = false;
  }
  const rows = await db.skill.findMany({
    where,
    orderBy: [
      { level: { orderIndex: "asc" } },
      { level: { name: "asc" } },
      { orderIndex: "asc" },
      { name: "asc" },
    ],
  });
  return rows.map(toSkill);
}

export async function create(
  db: DbClient,
  input: CreateSkillInput,
): Promise<Skill> {
  // schoolId comes from the AsyncLocalStorage tenant context. The
  // skills_consistency trigger will refuse a write whose level belongs to
  // a different school, so we don't repeat that check here.
  const schoolId = getSchoolId();
  if (!schoolId) {
    throw new Error(
      "skillRepository.create: no schoolId in tenant context; call inside withTenant()",
    );
  }
  const data = {
    schoolId,
    levelId: input.levelId,
    name: input.name,
    description: input.description ?? null,
    orderIndex: input.orderIndex,
    isArchived: input.isArchived ?? false,
  } as unknown as Prisma.SkillCreateInput;

  const row = await db.skill.create({ data });
  return toSkill(row);
}

export async function update(
  db: DbClient,
  id: string,
  input: UpdateSkillInput,
): Promise<Skill> {
  const row = await db.skill.update({
    where: { id },
    data: input as Prisma.SkillUpdateInput,
  });
  return toSkill(row);
}

export async function archive(db: DbClient, id: string): Promise<Skill> {
  const row = await db.skill.update({
    where: { id },
    data: { isArchived: true },
  });
  return toSkill(row);
}

export async function unarchive(db: DbClient, id: string): Promise<Skill> {
  const row = await db.skill.update({
    where: { id },
    data: { isArchived: false },
  });
  return toSkill(row);
}
