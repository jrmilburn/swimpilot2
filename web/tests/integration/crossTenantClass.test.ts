import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as classRepository from "../../src/repositories/classRepository";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const SCHOOL_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const TEACHER_B = "ddddddd0-0000-0000-0000-000000000002";
const LOCATION_B = "aaaaaaa0-0000-0000-0000-000000000002";
const LEVEL_B = "eeeeeee0-0000-0000-0000-000000000002";
const CLASS_B = "fffffff0-0000-0000-0000-000000000002";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations, families, students, class_levels, classes RESTART IDENTITY CASCADE`,
  );

  await admin.$executeRaw`
    INSERT INTO users (id, email, name, updated_at) VALUES
      (${USER_A}::uuid, 'a@example.com', 'User A', now()),
      (${TEACHER_B}::uuid, 'teacher.b@example.com', 'Teacher B', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${SCHOOL_A}::uuid, 'school-a', 'School A', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${SCHOOL_B}::uuid, 'school-b', 'School B', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${USER_A}::uuid, 'owner', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (gen_random_uuid(), ${SCHOOL_B}::uuid, ${TEACHER_B}::uuid, 'teacher', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO locations (id, school_id, name, created_by, updated_by, updated_at) VALUES
      (${LOCATION_B}::uuid, ${SCHOOL_B}::uuid, 'B Pool', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO class_levels (id, school_id, name, ratio, order_index, created_by, updated_by, updated_at) VALUES
      (${LEVEL_B}::uuid, ${SCHOOL_B}::uuid, 'B Infants', 4, 0, ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO classes (
      id, school_id, location_id, level_id, teacher_id,
      day_of_week, start_time, duration_minutes, capacity,
      created_by, updated_by, updated_at
    ) VALUES (
      ${CLASS_B}::uuid, ${SCHOOL_B}::uuid, ${LOCATION_B}::uuid, ${LEVEL_B}::uuid, ${TEACHER_B}::uuid,
      'monday', '16:00:00', 30, 4,
      ${USER_A}::uuid, ${USER_A}::uuid, now()
    )
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("classes: cross-tenant isolation under RLS", () => {
  test("scoped to A: getById of B's class returns null", async () => {
    const found = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classRepository.getById(tx, CLASS_B),
    );
    expect(found).toBeNull();
  });

  test("scoped to A: listBySchool sees zero rows from B", async () => {
    const page = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classRepository.listBySchool(tx),
    );
    expect(page.items.find((c) => c.id === CLASS_B)).toBeUndefined();
    expect(page.items.every((c) => c.schoolId === SCHOOL_A)).toBe(true);
  });

  test("scoped to A: listByLocation on B's location returns nothing", async () => {
    const list = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classRepository.listByLocation(tx, LOCATION_B),
    );
    expect(list).toHaveLength(0);
  });

  test("scoped to A: direct INSERT with school_id = B is blocked by WITH CHECK", async () => {
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        tx.class.create({
          data: {
            schoolId: SCHOOL_B,
            locationId: LOCATION_B,
            levelId: LEVEL_B,
            teacherId: TEACHER_B,
            dayOfWeek: "tuesday",
            startTime: new Date("1970-01-01T17:00:00Z"),
            durationMinutes: 30,
            capacity: 4,
            createdBy: USER_A,
            updatedBy: USER_A,
          },
        }),
      ),
    ).rejects.toThrow();

    // Confirm only the seeded B class exists.
    const rowsB = await admin.class.findMany({ where: { schoolId: SCHOOL_B } });
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]?.id).toBe(CLASS_B);
  });

  test("no tenant context: listBySchool sees nothing (fail closed)", async () => {
    const page = await classRepository.listBySchool(prisma);
    expect(page.items).toHaveLength(0);
  });
});
