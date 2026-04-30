import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as classLevelRepository from "../../src/repositories/classLevelRepository";
import * as classRepository from "../../src/repositories/classRepository";
import { WeekDay } from "../../src/domain/enums";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const TEACHER_A = "ddddddd0-0000-0000-0000-000000000099";
const LOCATION_A = "aaaaaaa0-0000-0000-0000-000000000099";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations, families, students, class_levels, classes RESTART IDENTITY CASCADE`,
  );
  await admin.$executeRaw`
    INSERT INTO users (id, email, name, updated_at) VALUES
      (${USER_A}::uuid, 'a@example.com', 'User A', now()),
      (${TEACHER_A}::uuid, 'teacher.a@example.com', 'Teacher A', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${SCHOOL_A}::uuid, 'school-a', 'School A', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${USER_A}::uuid, 'owner', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${TEACHER_A}::uuid, 'teacher', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO locations (id, school_id, name, created_by, updated_by, updated_at) VALUES
      (${LOCATION_A}::uuid, ${SCHOOL_A}::uuid, 'Pool', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("classes_consistency trigger: capacity ≤ level.ratio", () => {
  test("creating a class with capacity > level.ratio raises", async () => {
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, async (tx) => {
        const level = await classLevelRepository.create(tx, {
          name: "Cap-Infants",
          ratio: 4,
          orderIndex: 0,
        });
        return classRepository.create(tx, {
          locationId: LOCATION_A,
          levelId: level.id,
          teacherId: TEACHER_A,
          dayOfWeek: WeekDay.Monday,
          startTime: "16:00",
          durationMinutes: 30,
          capacity: 5,
        });
      }),
    ).rejects.toThrow(/cannot exceed level\.ratio/);
  });

  test("updating a class to capacity > level.ratio raises", async () => {
    const created = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      async (tx) => {
        const level = await classLevelRepository.create(tx, {
          name: "Cap-Beginner",
          ratio: 6,
          orderIndex: 1,
        });
        const klass = await classRepository.create(tx, {
          locationId: LOCATION_A,
          levelId: level.id,
          teacherId: TEACHER_A,
          dayOfWeek: WeekDay.Tuesday,
          startTime: "17:00",
          durationMinutes: 30,
          capacity: 4,
        });
        return { level, klass };
      },
    );

    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        classRepository.update(tx, created.klass.id, { capacity: 7 }),
      ),
    ).rejects.toThrow(/cannot exceed level\.ratio/);
  });

  test("CHECK constraint: capacity must be > 0", async () => {
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, async (tx) => {
        const level = await classLevelRepository.create(tx, {
          name: "Cap-Zero",
          ratio: 4,
          orderIndex: 2,
        });
        return classRepository.create(tx, {
          locationId: LOCATION_A,
          levelId: level.id,
          teacherId: TEACHER_A,
          dayOfWeek: WeekDay.Wednesday,
          startTime: "16:00",
          durationMinutes: 30,
          capacity: 0,
        });
      }),
    ).rejects.toThrow();
  });
});
