import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as classLevelRepository from "../../src/repositories/classLevelRepository";
import * as classRepository from "../../src/repositories/classRepository";
import { ClassStatus, WeekDay } from "../../src/domain/enums";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const TEACHER_A = "ddddddd0-0000-0000-0000-00000000000a";
const TEACHER_B = "ddddddd0-0000-0000-0000-00000000000b";
const LOCATION_A1 = "aaaaaaa0-0000-0000-0000-00000000000a";
const LOCATION_A2 = "aaaaaaa0-0000-0000-0000-00000000000b";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations, families, students, class_levels, classes RESTART IDENTITY CASCADE`,
  );

  await admin.$executeRaw`
    INSERT INTO users (id, email, name, updated_at) VALUES
      (${USER_A}::uuid, 'admin@example.com', 'Admin', now()),
      (${TEACHER_A}::uuid, 'teacher.a@example.com', 'Teacher A', now()),
      (${TEACHER_B}::uuid, 'teacher.b@example.com', 'Teacher B', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${SCHOOL_A}::uuid, 'school-a', 'School A', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${USER_A}::uuid, 'owner', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${TEACHER_A}::uuid, 'teacher', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${TEACHER_B}::uuid, 'teacher', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO locations (id, school_id, name, timezone, created_by, updated_by, updated_at) VALUES
      (${LOCATION_A1}::uuid, ${SCHOOL_A}::uuid, 'Pool 1', 'Australia/Sydney', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${LOCATION_A2}::uuid, ${SCHOOL_A}::uuid, 'Pool 2', 'Australia/Sydney', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("classRepository", () => {
  test("create class against level + location + teacher round-trips", async () => {
    const result = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      async (tx) => {
        const level = await classLevelRepository.create(tx, {
          name: "Infants",
          ratio: 4,
          orderIndex: 0,
        });
        const klass = await classRepository.create(tx, {
          locationId: LOCATION_A1,
          levelId: level.id,
          teacherId: TEACHER_A,
          dayOfWeek: WeekDay.Monday,
          startTime: "16:30:00",
          durationMinutes: 30,
          capacity: 4,
        });
        return { level, klass };
      },
    );

    expect(result.klass.schoolId).toBe(SCHOOL_A);
    expect(result.klass.teacherId).toBe(TEACHER_A);
    expect(result.klass.startTime).toBe("16:30:00");
    expect(result.klass.dayOfWeek).toBe(WeekDay.Monday);
    expect(result.klass.status).toBe(ClassStatus.Active);

    const row = await admin.class.findUnique({ where: { id: result.klass.id } });
    expect(row?.createdBy).toBe(USER_A);
    expect(row?.updatedBy).toBe(USER_A);
  });

  test("listByLocation and listByLevel filter and order Mon→Sun then start_time", async () => {
    const setup = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      async (tx) => {
        const beginner = await classLevelRepository.create(tx, {
          name: "Beginner-list",
          ratio: 6,
          orderIndex: 1,
        });
        const intermediate = await classLevelRepository.create(tx, {
          name: "Intermediate-list",
          ratio: 8,
          orderIndex: 2,
        });

        // Wednesday classes go after Monday by enum declared order.
        const wedClass = await classRepository.create(tx, {
          locationId: LOCATION_A2,
          levelId: beginner.id,
          teacherId: TEACHER_A,
          dayOfWeek: WeekDay.Wednesday,
          startTime: "17:00:00",
          durationMinutes: 30,
          capacity: 6,
        });
        const monEarly = await classRepository.create(tx, {
          locationId: LOCATION_A2,
          levelId: beginner.id,
          teacherId: TEACHER_A,
          dayOfWeek: WeekDay.Monday,
          startTime: "16:00:00",
          durationMinutes: 30,
          capacity: 6,
        });
        const monLate = await classRepository.create(tx, {
          locationId: LOCATION_A2,
          levelId: intermediate.id,
          teacherId: TEACHER_A,
          dayOfWeek: WeekDay.Monday,
          startTime: "17:30:00",
          durationMinutes: 45,
          capacity: 8,
        });
        return { beginner, intermediate, wedClass, monEarly, monLate };
      },
    );

    const byLocation = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classRepository.listByLocation(tx, LOCATION_A2),
    );
    const ids = byLocation.map((c) => c.id);
    expect(ids[0]).toBe(setup.monEarly.id);
    expect(ids[1]).toBe(setup.monLate.id);
    expect(ids[2]).toBe(setup.wedClass.id);

    const byLevel = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classRepository.listByLevel(tx, setup.beginner.id),
    );
    expect(byLevel.map((c) => c.id).sort()).toEqual(
      [setup.monEarly.id, setup.wedClass.id].sort(),
    );
  });

  test("update reassigns teacher and bumps updated_by + updated_at", async () => {
    const created = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      async (tx) => {
        const level = await classLevelRepository.create(tx, {
          name: "Reassignable",
          ratio: 6,
          orderIndex: 5,
        });
        return classRepository.create(tx, {
          locationId: LOCATION_A1,
          levelId: level.id,
          teacherId: TEACHER_A,
          dayOfWeek: WeekDay.Friday,
          startTime: "18:00:00",
          durationMinutes: 30,
          capacity: 6,
        });
      },
    );

    const before = await admin.class.findUnique({ where: { id: created.id } });

    const updated = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        classRepository.update(tx, created.id, {
          teacherId: TEACHER_B,
          status: ClassStatus.Cancelled,
        }),
    );
    expect(updated.teacherId).toBe(TEACHER_B);
    expect(updated.status).toBe(ClassStatus.Cancelled);

    const after = await admin.class.findUnique({ where: { id: created.id } });
    expect(after?.updatedBy).toBe(USER_A);
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before!.updatedAt.getTime(),
    );
  });

  test("teacher can be unset (null) on update", async () => {
    const created = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      async (tx) => {
        const level = await classLevelRepository.create(tx, {
          name: "Unassignable",
          ratio: 4,
          orderIndex: 6,
        });
        return classRepository.create(tx, {
          locationId: LOCATION_A1,
          levelId: level.id,
          teacherId: TEACHER_A,
          dayOfWeek: WeekDay.Saturday,
          startTime: "09:00:00",
          durationMinutes: 30,
          capacity: 4,
        });
      },
    );

    const cleared = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classRepository.update(tx, created.id, { teacherId: null }),
    );
    expect(cleared.teacherId).toBeNull();
  });
});
