import { prisma } from "../lib/db/client";
import type { TenantTx } from "../lib/db/withTenant";

export type DbClient = TenantTx | typeof prisma;

export type School = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  currency: string;
  // Profile fields (Sprint 4 / Chunk 2). All nullable in the domain type
  // because the column is nullable AND a school can legitimately skip the
  // profile step. Callers handle absence explicitly.
  legalName: string | null;
  tradingName: string | null;
  abn: string | null;
  gstRegistered: boolean | null;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  primaryContactPhone: string | null;
  // Holds a Supabase Storage path (`<school_id>/logo/<uuid>.<ext>`),
  // not a resolvable URL. Page render code signs it on read. The column
  // name stays `logo_url` rather than the more accurate `logo_path` to
  // avoid renaming mid-sprint; see docs/architecture.md "File storage".
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
  deletedAt: Date | null;
};

export type CreateSchoolInput = {
  slug: string;
  name: string;
  timezone: string;
  currency: string;
};

export type UpdateSchoolInput = Partial<{
  slug: string;
  name: string;
  timezone: string;
  currency: string;
  legalName: string | null;
  tradingName: string | null;
  abn: string | null;
  gstRegistered: boolean | null;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  primaryContactPhone: string | null;
  logoUrl: string | null;
  deletedAt: Date | null;
}>;

type SchoolRow = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  currency: string;
  legalName: string | null;
  tradingName: string | null;
  abn: string | null;
  gstRegistered: boolean | null;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  primaryContactPhone: string | null;
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
  deletedAt: Date | null;
};

function toSchool(row: SchoolRow): School {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    timezone: row.timezone,
    currency: row.currency,
    legalName: row.legalName,
    tradingName: row.tradingName,
    abn: row.abn,
    gstRegistered: row.gstRegistered,
    primaryContactName: row.primaryContactName,
    primaryContactEmail: row.primaryContactEmail,
    primaryContactPhone: row.primaryContactPhone,
    logoUrl: row.logoUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    deletedAt: row.deletedAt,
  };
}

export async function getById(
  db: DbClient,
  id: string,
): Promise<School | null> {
  const row = await db.school.findUnique({ where: { id } });
  return row ? toSchool(row) : null;
}

export async function create(
  db: DbClient,
  input: CreateSchoolInput,
): Promise<School> {
  // createdBy / updatedBy are stamped by the audit-fields extension at
  // runtime from the actor in AsyncLocalStorage, so they're omitted here
  // even though Prisma's static types require them.
  const row = await db.school.create({
    data: input as CreateSchoolInput & { createdBy: string; updatedBy: string },
  });
  return toSchool(row);
}

export async function update(
  db: DbClient,
  id: string,
  input: UpdateSchoolInput,
): Promise<School> {
  const row = await db.school.update({ where: { id }, data: input });
  return toSchool(row);
}
