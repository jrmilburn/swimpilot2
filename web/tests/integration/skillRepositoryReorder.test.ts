import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as skillRepository from "../../src/repositories/skillRepository";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const SCHOOL_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const LEVEL_A = "eeeeeee0-0000-0000-0000-00000000000a";
const LEVEL_A2 = "eeeeeee0-0000-0000-0000-00000000000c";
const LEVEL_B = "eeeeeee0-0000-0000-0000-00000000000b";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, class_levels, skills, student_skills RESTART IDENTITY CASCADE`,
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
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${USER_A}::uuid, 'owner', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (gen_random_uuid(), ${SCHOOL_B}::uuid, ${USER_A}::uuid, 'owner', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO class_levels (id, school_id, name, ratio, order_index, created_by, updated_by, updated_at) VALUES
      (${LEVEL_A}::uuid, ${SCHOOL_A}::uuid, 'Beginner', 6, 0, ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${LEVEL_A2}::uuid, ${SCHOOL_A}::uuid, 'Intermediate', 8, 1, ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${LEVEL_B}::uuid, ${SCHOOL_B}::uuid, 'Beginner', 6, 0, ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

beforeEach(async () => {
  await admin.$executeRawUnsafe(`DELETE FROM skills`);
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

async function seedThreeSkills(): Promise<{
  a: string;
  b: string;
  c: string;
}> {
  return withTenant({ schoolId: SCHOOL_A, userId: USER_A }, async (tx) => {
    const a = await skillRepository.create(tx, {
      levelId: LEVEL_A,
      name: "A",
      orderIndex: 0,
    });
    const b = await skillRepository.create(tx, {
      levelId: LEVEL_A,
      name: "B",
      orderIndex: 1,
    });
    const c = await skillRepository.create(tx, {
      levelId: LEVEL_A,
      name: "C",
      orderIndex: 2,
    });
    return { a: a.id, b: b.id, c: c.id };
  });
}

describe("skillRepository.reorder", () => {
  test("writes orderIndex 0..n-1 in the supplied order", async () => {
    const { a, b, c } = await seedThreeSkills();

    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
      skillRepository.reorder(tx, LEVEL_A, [c, a, b]),
    );

    const list = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => skillRepository.listByLevel(tx, LEVEL_A),
    );
    expect(list.map((s) => s.id)).toEqual([c, a, b]);
    expect(list.map((s) => s.orderIndex)).toEqual([0, 1, 2]);
  });

  test("rejects a stale list missing one id (count mismatch)", async () => {
    const { a, b } = await seedThreeSkills();

    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        skillRepository.reorder(tx, LEVEL_A, [a, b]),
      ),
    ).rejects.toThrow(/out of date/i);
  });

  test("rejects an id that belongs to a different level (membership check)", async () => {
    const { a, b, c } = await seedThreeSkills();
    // Insert a skill in LEVEL_A2 (same school, different level).
    const otherLevelSkill = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        skillRepository.create(tx, {
          levelId: LEVEL_A2,
          name: "Foreign-level",
          orderIndex: 0,
        }),
    );

    // LEVEL_A still has 3 rows; passing 3 ids including a different-level
    // id satisfies count-equality so per-id `liveIds.has` fires.
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        skillRepository.reorder(tx, LEVEL_A, [a, b, otherLevelSkill.id]),
      ),
    ).rejects.toThrow(/unknown skill/i);

    // And LEVEL_A's order is unchanged.
    const list = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => skillRepository.listByLevel(tx, LEVEL_A),
    );
    expect(list.map((s) => s.id)).toEqual([a, b, c]);
  });

  test("rejects an id that belongs to a different tenant (RLS hides B's row)", async () => {
    const { a, b } = await seedThreeSkills();

    // Insert a skill in school B via the admin connection.
    const foreignId = "ddddddd0-0000-0000-0000-000000000001";
    await admin.$executeRaw`
      INSERT INTO skills (id, school_id, level_id, name, order_index,
                          created_by, updated_by, updated_at)
      VALUES (${foreignId}::uuid, ${SCHOOL_B}::uuid, ${LEVEL_B}::uuid,
              'Foreign', 0, ${USER_A}::uuid, ${USER_A}::uuid, now())
    `;

    // School A LEVEL_A still has 3 rows; passing 3 ids including the B id
    // satisfies the count check, so the per-id `liveIds.has` fires.
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        skillRepository.reorder(tx, LEVEL_A, [a, b, foreignId]),
      ),
    ).rejects.toThrow(/unknown skill/i);

    // Foreign row unchanged.
    const foreignRow = await admin.skill.findUnique({
      where: { id: foreignId },
    });
    expect(foreignRow?.orderIndex).toBe(0);
  });
});
