import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/db/client";
import { getSchoolId } from "../lib/db/context";
import type { TenantTx } from "../lib/db/withTenant";
import type { Location } from "../domain/types";

export type DbClient = TenantTx | typeof prisma;

export type CreateLocationInput = {
  name: string;
  timezone?: string | null;
  addressLine?: string | null;
  suburb?: string | null;
  state?: string | null;
  postcode?: string | null;
  notes?: string | null;
};

export type UpdateLocationInput = Partial<{
  name: string;
  timezone: string | null;
  addressLine: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  notes: string | null;
  deletedAt: Date | null;
}>;

export type ListBySchoolOptions = {
  // Sprint 6's schedule editor may want history. Default behaviour for
  // the wizard and dashboard is to filter soft-deleted rows out.
  includeArchived?: boolean;
};

type LocationRow = Prisma.LocationGetPayload<Record<string, never>>;

function toLocation(row: LocationRow): Location {
  return {
    id: row.id,
    schoolId: row.schoolId,
    name: row.name,
    timezone: row.timezone,
    addressLine: row.addressLine,
    suburb: row.suburb,
    state: row.state,
    postcode: row.postcode,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getById(
  db: DbClient,
  id: string,
): Promise<Location | null> {
  const row = await db.location.findUnique({ where: { id } });
  if (!row) return null;
  // RLS filters by school_id, but a soft-deleted row is still readable
  // through the policy. Treat it as missing so callers don't have to
  // remember the convention.
  if (row.deletedAt) return null;
  return toLocation(row);
}

/**
 * List a school's locations in creation order. The order is editorial:
 * Sprint 6's schedule editor may want explicit reorder, but for the
 * onboarding wizard and dashboard creation order is the predictable
 * default. Soft-deleted rows are filtered out by default; pass
 * `includeArchived: true` for the rare future surface that wants them.
 */
export async function listBySchool(
  db: DbClient,
  options: ListBySchoolOptions = {},
): Promise<Location[]> {
  const where: Prisma.LocationWhereInput = {};
  if (!options.includeArchived) {
    where.deletedAt = null;
  }
  const rows = await db.location.findMany({
    where,
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toLocation);
}

export async function create(
  db: DbClient,
  input: CreateLocationInput,
): Promise<Location> {
  // schoolId is taken from AsyncLocalStorage (set by withTenant). The
  // RLS WITH CHECK clause on `locations` will reject any write whose
  // school_id doesn't match `app.school_id`, so a caller forging a
  // different schoolId via direct prisma access cannot land the row.
  const schoolId = getSchoolId();
  if (!schoolId) {
    throw new Error(
      "locationRepository.create: no schoolId in tenant context; call inside withTenant()",
    );
  }
  const data = {
    schoolId,
    name: input.name,
    timezone: input.timezone ?? null,
    addressLine: input.addressLine ?? null,
    suburb: input.suburb ?? null,
    state: input.state ?? null,
    postcode: input.postcode ?? null,
    notes: input.notes ?? null,
  } as unknown as Prisma.LocationCreateInput;

  const row = await db.location.create({ data });
  return toLocation(row);
}

export async function update(
  db: DbClient,
  id: string,
  input: UpdateLocationInput,
): Promise<Location> {
  const row = await db.location.update({
    where: { id },
    data: input as Prisma.LocationUpdateInput,
  });
  return toLocation(row);
}

/**
 * Soft-delete. Sets `deleted_at = now()`. Idempotent at the repository
 * boundary: an already-archived row's `deleted_at` is replaced with a
 * fresh timestamp, which is fine — there is no append-only contract on
 * archive. Callers that want "no-op when already archived" should check
 * the row first; for the wizard's archive button the timestamp churn is
 * harmless.
 *
 * No `unarchive` here — the wizard doesn't surface archived locations,
 * and the Sprint 6 schedule editor can add it when it needs the
 * surface.
 */
export async function archive(db: DbClient, id: string): Promise<Location> {
  const row = await db.location.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  return toLocation(row);
}
