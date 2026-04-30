import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/db/client";
import { getSchoolId } from "../lib/db/context";
import type { TenantTx } from "../lib/db/withTenant";
import type { Family } from "../domain/types";
import type { CommunicationPreference } from "../domain/enums";

export type DbClient = TenantTx | typeof prisma;

export type CreateFamilyInput = {
  primaryContactName: string;
  primaryContactEmail: string;
  primaryContactPhone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  suburb?: string | null;
  state?: string | null;
  postcode?: string | null;
  communicationPreference?: CommunicationPreference;
  notes?: string | null;
};

export type UpdateFamilyInput = Partial<{
  primaryContactName: string;
  primaryContactEmail: string;
  primaryContactPhone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  communicationPreference: CommunicationPreference;
  notes: string | null;
  deletedAt: Date | null;
}>;

export type ListBySchoolOptions = {
  limit?: number;
  cursor?: string | null;
};

export type FamilyPage = {
  items: Family[];
  nextCursor: string | null;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type FamilyRow = Prisma.FamilyGetPayload<Record<string, never>>;

function toFamily(row: FamilyRow): Family {
  return {
    id: row.id,
    schoolId: row.schoolId,
    primaryContactName: row.primaryContactName,
    primaryContactEmail: row.primaryContactEmail,
    primaryContactPhone: row.primaryContactPhone,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    suburb: row.suburb,
    state: row.state,
    postcode: row.postcode,
    communicationPreference:
      row.communicationPreference as Family["communicationPreference"],
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

export async function getById(
  db: DbClient,
  id: string,
): Promise<Family | null> {
  const row = await db.family.findUnique({ where: { id } });
  return row ? toFamily(row) : null;
}

export async function listBySchool(
  db: DbClient,
  options: ListBySchoolOptions = {},
): Promise<FamilyPage> {
  const limit = clampLimit(options.limit);

  // school_id filtering is handled by RLS — every query runs scoped by the
  // app.school_id GUC, so we order by id and paginate with a cursor.
  const rows = await db.family.findMany({
    take: limit + 1,
    orderBy: { id: "asc" },
    ...(options.cursor
      ? { cursor: { id: options.cursor }, skip: 1 }
      : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]!.id : null;

  return {
    items: page.map(toFamily),
    nextCursor,
  };
}

export async function create(
  db: DbClient,
  input: CreateFamilyInput,
): Promise<Family> {
  // schoolId is read from AsyncLocalStorage (the same context withTenant
  // populates), not from the caller — every write happens inside withTenant
  // and must match app.school_id (RLS WITH CHECK enforces this anyway).
  // created_by / updated_by are stamped by the audit extension.
  const schoolId = getSchoolId();
  if (!schoolId) {
    throw new Error(
      "familyRepository.create: no schoolId in tenant context; call inside withTenant()",
    );
  }

  const data = { ...input, schoolId } as unknown as Prisma.FamilyCreateInput;
  const row = await db.family.create({ data });
  return toFamily(row);
}

export async function update(
  db: DbClient,
  id: string,
  input: UpdateFamilyInput,
): Promise<Family> {
  const row = await db.family.update({ where: { id }, data: input });
  return toFamily(row);
}
