import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as studentRepository from "../../src/repositories/studentRepository";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const SCHOOL_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const LEVEL_B = "eeeeeee0-0000-0000-0000-00000000000b";
const FAMILY_B = "babababa-0000-0000-0000-00000000000b";
const STUDENT_B = "53000000-0000-0000-0000-00000000000b";
const SKILL_B = "5111aaaa-0000-0000-0000-00000000000b";
const STUDENT_SKILL_B = "5222aaaa-0000-0000-0000-00000000000b";

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
      (${LEVEL_B}::uuid, ${SCHOOL_B}::uuid, 'B Beginner', 6, 0, ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO families (id, school_id, primary_contact_name, primary_contact_email, created_by, updated_by, updated_at) VALUES
      (${FAMILY_B}::uuid, ${SCHOOL_B}::uuid, 'Family B', 'fam.b@example.com', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO students (id, school_id, family_id, first_name, last_name, date_of_birth, created_by, updated_by, updated_at) VALUES
      (${STUDENT_B}::uuid, ${SCHOOL_B}::uuid, ${FAMILY_B}::uuid, 'Bob', 'B', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO skills (id, school_id, level_id, name, order_index, created_by, updated_by, updated_at) VALUES
      (${SKILL_B}::uuid, ${SCHOOL_B}::uuid, ${LEVEL_B}::uuid, 'B Streamline', 0, ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO student_skills (id, school_id, student_id, skill_id, status, created_by, updated_by, updated_at) VALUES
      (${STUDENT_SKILL_B}::uuid, ${SCHOOL_B}::uuid, ${STUDENT_B}::uuid, ${SKILL_B}::uuid, 'achieved',
       ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("student_skills: cross-tenant isolation under RLS", () => {
  test("scoped to A: listSkills for B's student returns nothing", async () => {
    const list = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => studentRepository.listSkills(tx, STUDENT_B),
    );
    expect(list).toHaveLength(0);
  });

  test("scoped to A: listSkillsForLevel against B's level/student is empty", async () => {
    const rows = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        studentRepository.listSkillsForLevel(tx, STUDENT_B, LEVEL_B),
    );
    // RLS scopes both `skills` and `student_skills` so the LEFT JOIN sees
    // zero rows on the skills side — the answer is an empty list.
    expect(rows).toHaveLength(0);
  });

  test("scoped to A: direct create with school_id = B is blocked", async () => {
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        tx.studentSkill.create({
          data: {
            schoolId: SCHOOL_B,
            studentId: STUDENT_B,
            skillId: SKILL_B,
            status: "working_on",
            createdBy: USER_A,
            updatedBy: USER_A,
          },
        }),
      ),
    ).rejects.toThrow();

    const rowsB = await admin.studentSkill.findMany({
      where: { schoolId: SCHOOL_B },
    });
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]?.id).toBe(STUDENT_SKILL_B);
  });

  test("no tenant context: listSkills sees nothing (fail closed)", async () => {
    const list = await studentRepository.listSkills(prisma, STUDENT_B);
    expect(list).toHaveLength(0);
  });
});
