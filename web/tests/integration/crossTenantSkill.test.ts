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
const LEVEL_B = "eeeeeee0-0000-0000-0000-00000000000b";
const SKILL_B = "5111aaaa-0000-0000-0000-00000000000b";

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
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${USER_A}::uuid, 'owner', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO class_levels (id, school_id, name, ratio, order_index, created_by, updated_by, updated_at) VALUES
      (${LEVEL_A}::uuid, ${SCHOOL_A}::uuid, 'A Beginner', 6, 0, ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${LEVEL_B}::uuid, ${SCHOOL_B}::uuid, 'B Beginner', 6, 0, ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO skills (id, school_id, level_id, name, order_index, created_by, updated_by, updated_at) VALUES
      (${SKILL_B}::uuid, ${SCHOOL_B}::uuid, ${LEVEL_B}::uuid, 'B Streamline', 0, ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("skills: cross-tenant isolation under RLS", () => {
  test("scoped to A: getById of B's skill returns null", async () => {
    const found = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => skillRepository.getById(tx, SKILL_B),
    );
    expect(found).toBeNull();
  });

  test("scoped to A: listByLevel against B's level returns nothing", async () => {
    const list = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => skillRepository.listByLevel(tx, LEVEL_B),
    );
    expect(list).toHaveLength(0);
  });

  test("scoped to A: listBySchool sees zero rows from B", async () => {
    const list = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => skillRepository.listBySchool(tx),
    );
    expect(list.find((s) => s.id === SKILL_B)).toBeUndefined();
    expect(list.every((s) => s.schoolId === SCHOOL_A)).toBe(true);
  });

  test("scoped to A: direct create with school_id = B is blocked", async () => {
    // skillRepository.create derives schoolId from tenant context (A), so a
    // direct write into B requires going around the repo. The RLS policy's
    // WITH CHECK clause should reject it.
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        tx.skill.create({
          data: {
            schoolId: SCHOOL_B,
            levelId: LEVEL_B,
            name: "Cross",
            orderIndex: 0,
            createdBy: USER_A,
            updatedBy: USER_A,
          },
        }),
      ),
    ).rejects.toThrow();

    const rowsB = await admin.skill.findMany({ where: { schoolId: SCHOOL_B } });
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]?.id).toBe(SKILL_B);
  });

  test("no tenant context: listBySchool sees nothing (fail closed)", async () => {
    const list = await skillRepository.listBySchool(prisma);
    expect(list).toHaveLength(0);
  });
});
