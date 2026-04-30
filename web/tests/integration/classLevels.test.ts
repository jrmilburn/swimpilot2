import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
    `TRUNCATE schools, users, memberships, locations, families, students, class_levels, classes RESTART IDENTITY CASCADE`,
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

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("classLevelRepository", () => {
  test("create + getById round-trips and stamps audit fields", async () => {
    const level = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        classLevelRepository.create(tx, {
          name: "Infants",
          description: "6-24 months, parent-and-child",
          ratio: 4,
          orderIndex: 0,
          minAgeMonths: 6,
          maxAgeMonths: 24,
        }),
    );

    expect(level.schoolId).toBe(SCHOOL_A);
    expect(level.ratio).toBe(4);
    expect(level.defaultProgressionThreshold).toBe(80);

    const fetched = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classLevelRepository.getById(tx, level.id),
    );
    expect(fetched?.id).toBe(level.id);

    const row = await admin.classLevel.findUnique({ where: { id: level.id } });
    expect(row?.createdBy).toBe(USER_A);
    expect(row?.updatedBy).toBe(USER_A);
  });

  test("listBySchool orders by order_index then name", async () => {
    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, async (tx) => {
      await classLevelRepository.create(tx, {
        name: "Beginner",
        ratio: 6,
        orderIndex: 1,
      });
      await classLevelRepository.create(tx, {
        name: "Intermediate",
        ratio: 8,
        orderIndex: 2,
      });
      // Same orderIndex as Intermediate to exercise the name tiebreak.
      await classLevelRepository.create(tx, {
        name: "Aqua-fit",
        ratio: 8,
        orderIndex: 2,
      });
    });

    const list = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classLevelRepository.listBySchool(tx),
    );
    const names = list.map((l) => l.name);
    expect(names[0]).toBe("Infants");
    expect(names[1]).toBe("Beginner");
    // Tiebreak: Aqua-fit before Intermediate alphabetically at orderIndex 2.
    expect(names.indexOf("Aqua-fit")).toBeLessThan(names.indexOf("Intermediate"));
  });

  test("update mutates fields and stamps updated_by", async () => {
    const created = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        classLevelRepository.create(tx, {
          name: "Squad-prep",
          ratio: 8,
          orderIndex: 9,
        }),
    );

    const updated = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        classLevelRepository.update(tx, created.id, {
          ratio: 6,
          defaultProgressionThreshold: 90,
          description: "Pre-squad squad development",
        }),
    );

    expect(updated.ratio).toBe(6);
    expect(updated.defaultProgressionThreshold).toBe(90);
    expect(updated.description).toBe("Pre-squad squad development");
  });
});
