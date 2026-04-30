import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as skillRepository from "../../src/repositories/skillRepository";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const LEVEL_A = "eeeeeee0-0000-0000-0000-00000000000a";
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
      (${SCHOOL_A}::uuid, 'school-a', 'School A', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${USER_A}::uuid, 'owner', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO class_levels (id, school_id, name, ratio, order_index, created_by, updated_by, updated_at) VALUES
      (${LEVEL_A}::uuid, ${SCHOOL_A}::uuid, 'Beginner', 6, 0, ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${LEVEL_B}::uuid, ${SCHOOL_A}::uuid, 'Intermediate', 8, 1, ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("skillRepository", () => {
  test("create + getById round-trips and stamps audit fields", async () => {
    const skill = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        skillRepository.create(tx, {
          levelId: LEVEL_A,
          name: "Independent floating",
          description: "Float on back unassisted for 5 seconds",
          orderIndex: 0,
        }),
    );

    expect(skill.schoolId).toBe(SCHOOL_A);
    expect(skill.levelId).toBe(LEVEL_A);
    expect(skill.isArchived).toBe(false);
    expect(skill.description).toBe("Float on back unassisted for 5 seconds");

    const fetched = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => skillRepository.getById(tx, skill.id),
    );
    expect(fetched?.id).toBe(skill.id);

    const row = await admin.skill.findUnique({ where: { id: skill.id } });
    expect(row?.createdBy).toBe(USER_A);
    expect(row?.updatedBy).toBe(USER_A);
  });

  test("listByLevel orders by order_index then name; excludes archived by default", async () => {
    await admin.$executeRawUnsafe(`DELETE FROM skills`);

    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, async (tx) => {
      await skillRepository.create(tx, {
        levelId: LEVEL_A,
        name: "Streamline",
        orderIndex: 1,
      });
      await skillRepository.create(tx, {
        levelId: LEVEL_A,
        name: "Aqua-rolls",
        orderIndex: 1,
      });
      await skillRepository.create(tx, {
        levelId: LEVEL_A,
        name: "Recovery to standing",
        orderIndex: 0,
      });
      const archived = await skillRepository.create(tx, {
        levelId: LEVEL_A,
        name: "Old skill",
        orderIndex: 99,
      });
      await skillRepository.archive(tx, archived.id);
    });

    const visible = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => skillRepository.listByLevel(tx, LEVEL_A),
    );
    const names = visible.map((s) => s.name);
    expect(names).toEqual(["Recovery to standing", "Aqua-rolls", "Streamline"]);

    const all = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        skillRepository.listByLevel(tx, LEVEL_A, { includeArchived: true }),
    );
    expect(all.map((s) => s.name)).toContain("Old skill");
  });

  test("listBySchool orders by level then skill order_index", async () => {
    await admin.$executeRawUnsafe(`DELETE FROM skills`);

    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, async (tx) => {
      await skillRepository.create(tx, {
        levelId: LEVEL_B,
        name: "Backstroke 10m",
        orderIndex: 0,
      });
      await skillRepository.create(tx, {
        levelId: LEVEL_A,
        name: "Streamline",
        orderIndex: 0,
      });
      await skillRepository.create(tx, {
        levelId: LEVEL_A,
        name: "Bubbles",
        orderIndex: 1,
      });
    });

    const list = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => skillRepository.listBySchool(tx),
    );
    // Beginner (orderIndex 0) before Intermediate (orderIndex 1).
    expect(list.map((s) => s.name)).toEqual([
      "Streamline",
      "Bubbles",
      "Backstroke 10m",
    ]);
  });

  test("update mutates fields and stamps updated_by", async () => {
    const created = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        skillRepository.create(tx, {
          levelId: LEVEL_A,
          name: "Side breathing",
          orderIndex: 5,
        }),
    );

    const updated = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        skillRepository.update(tx, created.id, {
          description: "Bilateral breathing every third stroke",
          orderIndex: 4,
        }),
    );
    expect(updated.description).toBe("Bilateral breathing every third stroke");
    expect(updated.orderIndex).toBe(4);
  });

  test("archive / unarchive flip the flag", async () => {
    const created = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        skillRepository.create(tx, {
          levelId: LEVEL_A,
          name: "Diving entry",
          orderIndex: 7,
        }),
    );
    expect(created.isArchived).toBe(false);

    const archived = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => skillRepository.archive(tx, created.id),
    );
    expect(archived.isArchived).toBe(true);

    const unarchived = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => skillRepository.unarchive(tx, created.id),
    );
    expect(unarchived.isArchived).toBe(false);
  });
});
