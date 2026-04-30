import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const SCHOOL_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const LEVEL_A = "eeeeeee0-0000-0000-0000-00000000000a";
const LEVEL_B = "eeeeeee0-0000-0000-0000-00000000000b";
const FAMILY_A = "babababa-0000-0000-0000-00000000000a";
const FAMILY_B = "babababa-0000-0000-0000-00000000000b";
const STUDENT_A = "53000000-0000-0000-0000-00000000000a";
const STUDENT_B = "53000000-0000-0000-0000-00000000000b";
const SKILL_A = "5111aaaa-0000-0000-0000-00000000000a";
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
    INSERT INTO class_levels (id, school_id, name, ratio, order_index, created_by, updated_by, updated_at) VALUES
      (${LEVEL_A}::uuid, ${SCHOOL_A}::uuid, 'A Beginner', 6, 0, ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${LEVEL_B}::uuid, ${SCHOOL_B}::uuid, 'B Beginner', 6, 0, ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO families (id, school_id, primary_contact_name, primary_contact_email, created_by, updated_by, updated_at) VALUES
      (${FAMILY_A}::uuid, ${SCHOOL_A}::uuid, 'Family A', 'fam.a@example.com', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${FAMILY_B}::uuid, ${SCHOOL_B}::uuid, 'Family B', 'fam.b@example.com', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO students (id, school_id, family_id, first_name, last_name, date_of_birth, created_by, updated_by, updated_at) VALUES
      (${STUDENT_A}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'Alice', 'A', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${STUDENT_B}::uuid, ${SCHOOL_B}::uuid, ${FAMILY_B}::uuid, 'Bob', 'B', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO skills (id, school_id, level_id, name, order_index, created_by, updated_by, updated_at) VALUES
      (${SKILL_A}::uuid, ${SCHOOL_A}::uuid, ${LEVEL_A}::uuid, 'Streamline', 0, ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${SKILL_B}::uuid, ${SCHOOL_B}::uuid, ${LEVEL_B}::uuid, 'Streamline', 0, ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("skills_consistency trigger", () => {
  test("skill with level_id from another school raises", async () => {
    await expect(
      admin.$executeRaw`
        INSERT INTO skills (
          school_id, level_id, name, order_index,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${LEVEL_B}::uuid, 'Foreign level', 0,
          ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/must match level\.school_id/);
  });

  test("UPDATE that desyncs school_id from level raises", async () => {
    await expect(
      admin.$executeRaw`
        UPDATE skills SET school_id = ${SCHOOL_B}::uuid
        WHERE id = ${SKILL_A}::uuid
      `,
    ).rejects.toThrow(/must match level\.school_id/);
  });
});

describe("student_skills_consistency trigger", () => {
  test("student_skill with student from another school raises", async () => {
    await expect(
      admin.$executeRaw`
        INSERT INTO student_skills (
          school_id, student_id, skill_id, status,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${STUDENT_B}::uuid, ${SKILL_A}::uuid, 'working_on',
          ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/must match student\.school_id/);
  });

  test("student_skill with skill from another school raises", async () => {
    await expect(
      admin.$executeRaw`
        INSERT INTO student_skills (
          school_id, student_id, skill_id, status,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${STUDENT_A}::uuid, ${SKILL_B}::uuid, 'working_on',
          ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/must match skill\.school_id/);
  });
});
