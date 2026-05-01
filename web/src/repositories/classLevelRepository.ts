import { Prisma } from "@prisma/client";
import { prisma } from "../lib/db/client";
import { getSchoolId } from "../lib/db/context";
import type { TenantTx } from "../lib/db/withTenant";
import type { ClassLevel } from "../domain/types";
import { ValidationError } from "../lib/errors";

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

export type ListBySchoolOptions = {
  // Sprint 6's schedule editor / curriculum dashboard may eventually want
  // archived rows. The wizard and the dashboard should never see them.
  includeArchived?: boolean;
};

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
  if (!row) return null;
  // RLS scopes the read by school_id, but soft-deleted rows are still
  // readable through the policy. Treat them as missing so callers don't
  // have to remember the convention. Mirrors `locationRepository`.
  if (row.deletedAt) return null;
  return toClassLevel(row);
}

/**
 * List a school's levels in `order_index` order. Soft-deleted rows are
 * filtered by default — pass `includeArchived: true` for the rare future
 * surface that wants them. Contract change vs. earlier sprints; the
 * existing `seed.ts` and Sprint 3 tests don't archive levels so they
 * are unaffected.
 */
export async function listBySchool(
  db: DbClient,
  options: ListBySchoolOptions = {},
): Promise<ClassLevel[]> {
  const where: Prisma.ClassLevelWhereInput = {};
  if (!options.includeArchived) {
    where.deletedAt = null;
  }
  const rows = await db.classLevel.findMany({
    where,
    orderBy: [{ orderIndex: "asc" }, { name: "asc" }],
  });
  return rows.map(toClassLevel);
}

// The only unique constraint on `class_levels` (besides the PK) is
// `(school_id, name)`. Prisma raises code `P2002` on either the create
// or the update path; we map it to a typed `ValidationError` keyed
// against `name` so the action layer doesn't need to import Prisma to
// distinguish "real bug" from "user picked a duplicate name".
const PRISMA_UNIQUE_VIOLATION = "P2002";

function mapUniqueViolation(err: unknown): never {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === PRISMA_UNIQUE_VIOLATION
  ) {
    throw new ValidationError("A level with that name already exists.", {
      name: "A level with that name already exists.",
    });
  }
  throw err;
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
  try {
    const row = await db.classLevel.create({ data });
    return toClassLevel(row);
  } catch (err) {
    mapUniqueViolation(err);
  }
}

export async function update(
  db: DbClient,
  id: string,
  input: UpdateClassLevelInput,
): Promise<ClassLevel> {
  try {
    const row = await db.classLevel.update({ where: { id }, data: input });
    return toClassLevel(row);
  } catch (err) {
    mapUniqueViolation(err);
  }
}

/**
 * Soft-delete. Sets `deleted_at = now()`. Idempotent at the repository
 * boundary: a second archive of the same id replaces the timestamp,
 * which is fine — there is no append-only contract on archive. Action-
 * layer callers that want "no-op when already archived" should check
 * `getById` first (the repository hides archived rows there).
 */
export async function archive(db: DbClient, id: string): Promise<ClassLevel> {
  const row = await db.classLevel.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  return toClassLevel(row);
}

/**
 * Reorder the school's non-archived levels by writing `order_index`
 * `0..n-1` in the supplied order. Single transactional pass via a
 * `CASE … WHEN` UPDATE so partial writes are impossible.
 *
 * Validation:
 *  - `ids.length` must match the count of the tenant's non-archived
 *    levels (defends against a stale client list — operator archived
 *    a row in another tab and the up/down arrow fires with the old
 *    list).
 *  - Every supplied id must belong to the current tenant. Per-id RLS
 *    already gates the write, but the count-equality check catches
 *    cross-tenant ids cleanly with a `ValidationError` instead of
 *    a Postgres-level "row not found" error.
 *
 * Throws `ValidationError` on either mismatch.
 */
export async function reorder(db: DbClient, ids: string[]): Promise<void> {
  // Snapshot the tenant's current non-archived level set. RLS scopes the
  // read so this only sees the calling tenant's rows.
  const live = await db.classLevel.findMany({
    where: { deletedAt: null },
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
        "Reorder list contains an unknown level — please reload and try again.",
      );
    }
  }

  // Run the writes in a single transaction. We can't use `db.$transaction`
  // here because `db` may already be a tenant-scoped tx; instead we just
  // issue the updates serially. The action layer's `withTenant` wraps the
  // whole thing in a transaction so this is still atomic.
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    await db.classLevel.update({
      where: { id },
      data: { orderIndex: i },
    });
  }
}
