import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
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

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, class_levels RESTART IDENTITY CASCADE`,
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
});

beforeEach(async () => {
  await admin.$executeRawUnsafe(`DELETE FROM class_levels`);
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

async function seedThreeLevels(): Promise<{ a: string; b: string; c: string }> {
  return withTenant({ schoolId: SCHOOL_A, userId: USER_A }, async (tx) => {
    const a = await classLevelRepository.create(tx, {
      name: "A",
      ratio: 4,
      orderIndex: 0,
    });
    const b = await classLevelRepository.create(tx, {
      name: "B",
      ratio: 6,
      orderIndex: 1,
    });
    const c = await classLevelRepository.create(tx, {
      name: "C",
      ratio: 8,
      orderIndex: 2,
    });
    return { a: a.id, b: b.id, c: c.id };
  });
}

describe("classLevelRepository.reorder", () => {
  test("writes orderIndex 0..n-1 in the supplied order", async () => {
    const { a, b, c } = await seedThreeLevels();

    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
      classLevelRepository.reorder(tx, [c, a, b]),
    );

    const list = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classLevelRepository.listBySchool(tx),
    );
    expect(list.map((l) => l.id)).toEqual([c, a, b]);
    expect(list.map((l) => l.orderIndex)).toEqual([0, 1, 2]);
  });

  test("rejects a stale list missing one id (count mismatch)", async () => {
    const { a, b } = await seedThreeLevels();

    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        classLevelRepository.reorder(tx, [a, b]),
      ),
    ).rejects.toThrow(/out of date/i);
  });

  test("rejects a foreign id (RLS hides B's row, count mismatch fires first)", async () => {
    const { a, b, c } = await seedThreeLevels();

    // Insert a row in school B via the admin connection.
    const foreignId = "eeeeeee0-0000-0000-0000-000000000001";
    await admin.$executeRaw`
      INSERT INTO class_levels (id, school_id, name, ratio, order_index,
                                created_by, updated_by, updated_at)
      VALUES (${foreignId}::uuid, ${SCHOOL_B}::uuid, 'Foreign', 4, 0,
              ${USER_A}::uuid, ${USER_A}::uuid, now())
    `;

    // School A still has 3 rows; passing 3 ids including a B id satisfies
    // the count check, so the per-id `liveIds.has` check is what fires.
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        classLevelRepository.reorder(tx, [a, b, foreignId]),
      ),
    ).rejects.toThrow(/unknown level/i);

    // And the foreign row is unchanged.
    const foreignRow = await admin.classLevel.findUnique({
      where: { id: foreignId },
    });
    expect(foreignRow?.orderIndex).toBe(0);

    // No-op cleanup: also confirm school A's order is unchanged.
    const list = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classLevelRepository.listBySchool(tx),
    );
    expect(list.map((l) => l.id)).toEqual([a, b, c]);
  });
});
