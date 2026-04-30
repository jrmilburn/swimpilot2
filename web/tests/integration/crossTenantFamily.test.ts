import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as familyRepository from "../../src/repositories/familyRepository";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const SCHOOL_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const FAMILY_B = "ddddddd0-0000-0000-0000-000000000001";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations, families, students RESTART IDENTITY CASCADE`,
  );

  await admin.$executeRaw`
    INSERT INTO users (id, email, name, updated_at) VALUES
      (${USER_A}::uuid, 'a@example.com', 'User A', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${SCHOOL_A}::uuid, 'school-a', 'School A', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${SCHOOL_B}::uuid, 'school-b', 'School B', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${USER_A}::uuid, 'owner', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  // A family that belongs to school B — should be invisible to A.
  await admin.$executeRaw`
    INSERT INTO families (id, school_id, primary_contact_name, primary_contact_email, created_by, updated_by, updated_at) VALUES
      (${FAMILY_B}::uuid, ${SCHOOL_B}::uuid, 'Tenant B Family', 'b@example.com', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("families: cross-tenant isolation under RLS", () => {
  test("scoped to A: getById of B's family returns null", async () => {
    const found = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => familyRepository.getById(tx, FAMILY_B),
    );
    expect(found).toBeNull();
  });

  test("scoped to A: listBySchool sees zero rows from B", async () => {
    const page = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => familyRepository.listBySchool(tx),
    );
    expect(page.items.every((f) => f.schoolId === SCHOOL_A)).toBe(true);
    expect(page.items.find((f) => f.id === FAMILY_B)).toBeUndefined();
  });

  test("scoped to A: direct INSERT with school_id = B is blocked by WITH CHECK", async () => {
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        tx.family.create({
          data: {
            schoolId: SCHOOL_B,
            primaryContactName: "Cross Tenant",
            primaryContactEmail: "x@example.com",
            createdBy: USER_A,
            updatedBy: USER_A,
          },
        }),
      ),
    ).rejects.toThrow();

    // Confirm nothing was inserted from school A's perspective on B's row.
    const rowsB = await admin.family.findMany({ where: { schoolId: SCHOOL_B } });
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]?.id).toBe(FAMILY_B);
  });

  test("no tenant context: listBySchool sees nothing (fail closed)", async () => {
    const page = await familyRepository.listBySchool(prisma);
    expect(page.items).toHaveLength(0);
  });
});
