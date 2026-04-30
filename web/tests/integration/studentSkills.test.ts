import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as skillRepository from "../../src/repositories/skillRepository";
import * as studentRepository from "../../src/repositories/studentRepository";
import { SkillStatus } from "../../src/domain/enums";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const USER_B = "cccccccc-cccc-cccc-cccc-cccccccccccd";
const LEVEL_A = "eeeeeee0-0000-0000-0000-00000000000a";
const FAMILY_A = "babababa-0000-0000-0000-00000000000a";
const STUDENT_A1 = "53000000-0000-0000-0000-00000000000a";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations, families, students,
       class_levels, classes, enrolments, class_sessions, attendance,
       skills, student_skills
     RESTART IDENTITY CASCADE`,
  );

  await admin.$executeRaw`
    INSERT INTO users (id, email, name, updated_at) VALUES
      (${USER_A}::uuid, 'a@example.com', 'User A', now()),
      (${USER_B}::uuid, 'b@example.com', 'User B', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${SCHOOL_A}::uuid, 'school-a', 'School A', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${USER_A}::uuid, 'owner', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${USER_B}::uuid, 'teacher', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO class_levels (id, school_id, name, ratio, order_index, created_by, updated_by, updated_at) VALUES
      (${LEVEL_A}::uuid, ${SCHOOL_A}::uuid, 'Beginner', 6, 0, ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO families (id, school_id, primary_contact_name, primary_contact_email, created_by, updated_by, updated_at) VALUES
      (${FAMILY_A}::uuid, ${SCHOOL_A}::uuid, 'Family A', 'fam.a@example.com', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO students (id, school_id, family_id, first_name, last_name, date_of_birth, created_by, updated_by, updated_at) VALUES
      (${STUDENT_A1}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'Alice', 'A', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

async function reset() {
  await admin.$executeRawUnsafe(`DELETE FROM student_skills`);
  await admin.$executeRawUnsafe(`DELETE FROM skills`);
}

describe("studentRepository.markSkill", () => {
  test("creates a row when none exists and stamps audit fields", async () => {
    await reset();
    const skill = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        skillRepository.create(tx, {
          levelId: LEVEL_A,
          name: "Streamline",
          orderIndex: 0,
        }),
    );

    const marked = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        studentRepository.markSkill(tx, {
          studentId: STUDENT_A1,
          skillId: skill.id,
          status: SkillStatus.WorkingOn,
          note: "needs more practice",
        }),
    );
    expect(marked.status).toBe(SkillStatus.WorkingOn);
    expect(marked.note).toBe("needs more practice");
    expect(marked.schoolId).toBe(SCHOOL_A);

    const row = await admin.studentSkill.findUnique({
      where: { id: marked.id },
    });
    expect(row?.createdBy).toBe(USER_A);
    expect(row?.updatedBy).toBe(USER_A);
  });

  test("same-status mark is a no-op (updated_at and updated_by unchanged)", async () => {
    await reset();
    const skill = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        skillRepository.create(tx, {
          levelId: LEVEL_A,
          name: "Bubbles",
          orderIndex: 0,
        }),
    );

    const first = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        studentRepository.markSkill(tx, {
          studentId: STUDENT_A1,
          skillId: skill.id,
          status: SkillStatus.WorkingOn,
        }),
    );
    const firstRow = await admin.studentSkill.findUnique({
      where: { id: first.id },
    });

    // Different actor on the second tap — if anything wrote, updated_by would
    // become USER_B. The no-op preserves the original audit fields.
    const second = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_B },
      (tx) =>
        studentRepository.markSkill(tx, {
          studentId: STUDENT_A1,
          skillId: skill.id,
          status: SkillStatus.WorkingOn,
        }),
    );
    expect(second.id).toBe(first.id);

    const secondRow = await admin.studentSkill.findUnique({
      where: { id: first.id },
    });
    expect(secondRow?.updatedAt.getTime()).toBe(firstRow?.updatedAt.getTime());
    expect(secondRow?.updatedBy).toBe(USER_A);
  });

  test("status change updates the row and bumps updated_by", async () => {
    await reset();
    const skill = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        skillRepository.create(tx, {
          levelId: LEVEL_A,
          name: "Recovery to standing",
          orderIndex: 0,
        }),
    );

    const first = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        studentRepository.markSkill(tx, {
          studentId: STUDENT_A1,
          skillId: skill.id,
          status: SkillStatus.WorkingOn,
        }),
    );

    const second = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_B },
      (tx) =>
        studentRepository.markSkill(tx, {
          studentId: STUDENT_A1,
          skillId: skill.id,
          status: SkillStatus.Achieved,
          note: "nailed it!",
        }),
    );
    expect(second.id).toBe(first.id);
    expect(second.status).toBe(SkillStatus.Achieved);
    expect(second.note).toBe("nailed it!");

    const row = await admin.studentSkill.findUnique({
      where: { id: first.id },
    });
    expect(row?.updatedBy).toBe(USER_B);
  });
});

describe("studentRepository.listSkills / listSkillsForLevel", () => {
  test("listSkills returns only rows that exist for the student", async () => {
    await reset();
    const [s1, s2] = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      async (tx) => {
        const a = await skillRepository.create(tx, {
          levelId: LEVEL_A,
          name: "Aqua-rolls",
          orderIndex: 0,
        });
        const b = await skillRepository.create(tx, {
          levelId: LEVEL_A,
          name: "Bubbles",
          orderIndex: 1,
        });
        await skillRepository.create(tx, {
          levelId: LEVEL_A,
          name: "Streamline",
          orderIndex: 2,
        });
        return [a, b];
      },
    );

    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, async (tx) => {
      await studentRepository.markSkill(tx, {
        studentId: STUDENT_A1,
        skillId: s1.id,
        status: SkillStatus.WorkingOn,
      });
      await studentRepository.markSkill(tx, {
        studentId: STUDENT_A1,
        skillId: s2.id,
        status: SkillStatus.Achieved,
      });
    });

    const list = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => studentRepository.listSkills(tx, STUDENT_A1),
    );
    expect(list).toHaveLength(2);
    expect(list.map((r) => r.skillId).sort()).toEqual([s1.id, s2.id].sort());
  });

  test("listSkillsForLevel returns one row per non-archived skill, synthesising missing rows", async () => {
    await reset();
    const skills = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      async (tx) => {
        const a = await skillRepository.create(tx, {
          levelId: LEVEL_A,
          name: "Streamline",
          orderIndex: 0,
        });
        const b = await skillRepository.create(tx, {
          levelId: LEVEL_A,
          name: "Bubbles",
          orderIndex: 1,
        });
        const c = await skillRepository.create(tx, {
          levelId: LEVEL_A,
          name: "Backstroke 5m",
          orderIndex: 2,
        });
        const archived = await skillRepository.create(tx, {
          levelId: LEVEL_A,
          name: "Old skill",
          orderIndex: 99,
        });
        await skillRepository.archive(tx, archived.id);
        return { a, b, c };
      },
    );

    // Mark only one of the three live skills.
    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
      studentRepository.markSkill(tx, {
        studentId: STUDENT_A1,
        skillId: skills.b.id,
        status: SkillStatus.Achieved,
      }),
    );

    const rows = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => studentRepository.listSkillsForLevel(tx, STUDENT_A1, LEVEL_A),
    );

    // Three live skills, one row each. Archived skill is excluded.
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.skillId)).toEqual([
      skills.a.id,
      skills.b.id,
      skills.c.id,
    ]);

    const a = rows.find((r) => r.skillId === skills.a.id)!;
    expect(a.status).toBe(SkillStatus.NotIntroduced);
    expect(a.id).toBe("");

    const b = rows.find((r) => r.skillId === skills.b.id)!;
    expect(b.status).toBe(SkillStatus.Achieved);
    expect(b.id).not.toBe("");
  });
});
