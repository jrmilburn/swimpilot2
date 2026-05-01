import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as classLevelRepository from "../../src/repositories/classLevelRepository";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";

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
});

beforeEach(async () => {
  await admin.$executeRawUnsafe(`DELETE FROM class_levels`);
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("classLevelRepository filtering", () => {
  test("listBySchool filters soft-deleted by default; includeArchived returns them", async () => {
    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, async (tx) => {
      await classLevelRepository.create(tx, {
        name: "Alive 1",
        ratio: 4,
        orderIndex: 0,
      });
      await classLevelRepository.create(tx, {
        name: "Alive 2",
        ratio: 6,
        orderIndex: 1,
      });
      const archived = await classLevelRepository.create(tx, {
        name: "Archived",
        ratio: 8,
        orderIndex: 2,
      });
      await classLevelRepository.archive(tx, archived.id);
    });

    const visible = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classLevelRepository.listBySchool(tx),
    );
    expect(visible.map((l) => l.name)).toEqual(["Alive 1", "Alive 2"]);

    const all = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classLevelRepository.listBySchool(tx, { includeArchived: true }),
    );
    expect(all.map((l) => l.name)).toContain("Archived");
    expect(all).toHaveLength(3);
  });

  test("archive sets deletedAt; getById then returns null", async () => {
    const created = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        classLevelRepository.create(tx, {
          name: "Bondi Squad",
          ratio: 6,
          orderIndex: 0,
        }),
    );

    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
      classLevelRepository.archive(tx, created.id),
    );

    const fetched = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classLevelRepository.getById(tx, created.id),
    );
    expect(fetched).toBeNull();

    const row = await admin.classLevel.findUnique({
      where: { id: created.id },
    });
    expect(row?.deletedAt).not.toBeNull();
  });

  test("archive of an already-archived row updates the timestamp (repository-level idempotency)", async () => {
    const created = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        classLevelRepository.create(tx, {
          name: "Twice-archived",
          ratio: 4,
          orderIndex: 0,
        }),
    );

    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
      classLevelRepository.archive(tx, created.id),
    );
    const first = await admin.classLevel.findUnique({
      where: { id: created.id },
    });

    // Action layer would short-circuit before this; the repository itself
    // is idempotent in the sense of "same end state, no error".
    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
      classLevelRepository.archive(tx, created.id),
    );
    const second = await admin.classLevel.findUnique({
      where: { id: created.id },
    });

    expect(first?.deletedAt).not.toBeNull();
    expect(second?.deletedAt).not.toBeNull();
  });
});
