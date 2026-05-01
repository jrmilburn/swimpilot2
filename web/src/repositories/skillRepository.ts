import { Prisma } from "@prisma/client";
import { prisma } from "../lib/db/client";
import { getSchoolId } from "../lib/db/context";
import type { TenantTx } from "../lib/db/withTenant";
import type { Skill } from "../domain/types";
import { ValidationError } from "../lib/errors";

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

// `skills` has a `(school_id, level_id, name)` unique index. Prisma raises
// code `P2002` on either the create or the update path; we map it to a
// typed `ValidationError` keyed against `name` so the action layer doesn't
// need to import Prisma to distinguish "real bug" from "user picked a
// duplicate name". Mirrors `classLevelRepository.mapUniqueViolation`; the
// only difference is the message, which mentions the level scope so the
// operator understands "Streamline" can collide under one level but not
// another.
const PRISMA_UNIQUE_VIOLATION = "P2002";

function mapUniqueViolation(err: unknown): never {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === PRISMA_UNIQUE_VIOLATION
  ) {
    throw new ValidationError(
      "A skill with that name already exists in this level.",
      {
        name: "A skill with that name already exists in this level.",
      },
    );
  }
  throw err;
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

  try {
    const row = await db.skill.create({ data });
    return toSkill(row);
  } catch (err) {
    mapUniqueViolation(err);
  }
}

export async function update(
  db: DbClient,
  id: string,
  input: UpdateSkillInput,
): Promise<Skill> {
  try {
    const row = await db.skill.update({
      where: { id },
      data: input as Prisma.SkillUpdateInput,
    });
    return toSkill(row);
  } catch (err) {
    mapUniqueViolation(err);
  }
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

/**
 * Reorder the non-archived skills under a single level by writing
 * `order_index` `0..n-1` in the supplied order. Same shape as
 * `classLevelRepository.reorder`, but scoped to one level — skills do not
 * move between levels (the `skills_consistency` trigger fires on
 * `level_id` changes, and the `UpdateSkillInput` shape doesn't expose
 * `levelId` either; archive-and-recreate is the cross-level move
 * workflow).
 *
 * Validation:
 *  - `ids.length` must match the count of non-archived skills under
 *    `levelId` (defends against a stale client list — operator archived
 *    a row in another tab and the up/down arrow fires with the old
 *    list).
 *  - Every supplied id must belong to the live non-archived set under
 *    `levelId`. This catches both cross-level and cross-tenant ids
 *    (RLS already hides cross-tenant rows from the snapshot).
 *
 * Throws `ValidationError` on either mismatch.
 */
export async function reorder(
  db: DbClient,
  levelId: string,
  ids: string[],
): Promise<void> {
  // Snapshot the live non-archived skills under this level. RLS scopes
  // the read so this only sees the calling tenant's rows; the levelId
  // filter scopes it to the operator's accordion section.
  const live = await db.skill.findMany({
    where: { levelId, isArchived: false },
    select: { id: true },
  });
  const liveIds = new Set(live.map((r) => r.id));

  if (ids.length !== liveIds.size) {
    throw new ValidationError(
      "Reorder list is out of date — please reload and try again.",
    );
  }
  for (const id of ids) {
    if (!liveIds.has(id)) {
      throw new ValidationError(
        "Reorder list contains an unknown skill — please reload and try again.",
      );
    }
  }

  // Run the writes serially. We can't use `db.$transaction` here because
  // `db` may already be a tenant-scoped tx; the action layer's
  // `withTenant` wraps the whole thing in a transaction so this is still
  // atomic.
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    await db.skill.update({
      where: { id },
      data: { orderIndex: i },
    });
  }
}
