import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
    `TRUNCATE schools, users, memberships, locations, families, students,
       class_levels, classes, enrolments, class_sessions, attendance,
       skills, student_skills
     RESTART IDENTITY CASCADE`,
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

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("skills (school_id, level_id, name) uniqueness", () => {
  test("rejects a duplicate name within the same level", async () => {
    await admin.$executeRawUnsafe(`DELETE FROM skills`);
    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
      skillRepository.create(tx, {
        levelId: LEVEL_A,
        name: "Streamline",
        orderIndex: 0,
      }),
    );
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        skillRepository.create(tx, {
          levelId: LEVEL_A,
          name: "Streamline",
          orderIndex: 1,
        }),
      ),
    ).rejects.toThrow();
  });

  test("allows the same name on a different level within the same school", async () => {
    await admin.$executeRawUnsafe(`DELETE FROM skills`);
    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, async (tx) => {
      await skillRepository.create(tx, {
        levelId: LEVEL_A,
        name: "Streamline",
        orderIndex: 0,
      });
      const intermediate = await skillRepository.create(tx, {
        levelId: LEVEL_A2,
        name: "Streamline",
        orderIndex: 0,
      });
      expect(intermediate.name).toBe("Streamline");
      expect(intermediate.levelId).toBe(LEVEL_A2);
    });
  });

  test("allows the same name in another school", async () => {
    await admin.$executeRawUnsafe(`DELETE FROM skills`);
    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
      skillRepository.create(tx, {
        levelId: LEVEL_A,
        name: "Streamline",
        orderIndex: 0,
      }),
    );
    const inB = await withTenant(
      { schoolId: SCHOOL_B, userId: USER_A },
      (tx) =>
        skillRepository.create(tx, {
          levelId: LEVEL_B,
          name: "Streamline",
          orderIndex: 0,
        }),
    );
    expect(inB.schoolId).toBe(SCHOOL_B);
    expect(inB.name).toBe("Streamline");
  });
});
