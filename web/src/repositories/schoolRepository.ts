import { prisma } from "../lib/db/client";
import type { TenantTx } from "../lib/db/withTenant";

export type DbClient = TenantTx | typeof prisma;

export type School = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  currency: string;
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
  deletedAt: Date | null;
}>;

type SchoolRow = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  currency: string;
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
