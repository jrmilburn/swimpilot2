import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as classLevelRepository from "../../src/repositories/classLevelRepository";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const SCHOOL_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const LEVEL_B = "eeeeeee0-0000-0000-0000-000000000001";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations, families, students, class_levels, classes RESTART IDENTITY CASCADE`,
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
  await admin.$executeRaw`
    INSERT INTO class_levels (id, school_id, name, ratio, order_index, created_by, updated_by, updated_at) VALUES
      (${LEVEL_B}::uuid, ${SCHOOL_B}::uuid, 'Tenant B Level', 4, 0, ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("class_levels: cross-tenant isolation under RLS", () => {
  test("scoped to A: getById of B's level returns null", async () => {
    const found = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classLevelRepository.getById(tx, LEVEL_B),
    );
    expect(found).toBeNull();
  });

  test("scoped to A: listBySchool sees zero rows from B", async () => {
    const list = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classLevelRepository.listBySchool(tx),
    );
    expect(list.find((l) => l.id === LEVEL_B)).toBeUndefined();
    expect(list.every((l) => l.schoolId === SCHOOL_A)).toBe(true);
  });

  test("scoped to A: direct INSERT with school_id = B is blocked by WITH CHECK", async () => {
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        tx.classLevel.create({
          data: {
            schoolId: SCHOOL_B,
            name: "Cross",
            ratio: 4,
            orderIndex: 0,
            createdBy: USER_A,
            updatedBy: USER_A,
          },
        }),
      ),
    ).rejects.toThrow();

    const rowsB = await admin.classLevel.findMany({
      where: { schoolId: SCHOOL_B },
    });
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]?.id).toBe(LEVEL_B);
  });

  test("no tenant context: listBySchool sees nothing (fail closed)", async () => {
    const list = await classLevelRepository.listBySchool(prisma);
    expect(list).toHaveLength(0);
  });
});
