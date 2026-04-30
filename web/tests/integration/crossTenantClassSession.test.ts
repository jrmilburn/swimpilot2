import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as classSessionRepository from "../../src/repositories/classSessionRepository";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const SCHOOL_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const TEACHER_A = "ddddddd0-0000-0000-0000-00000000000a";
const TEACHER_B = "ddddddd0-0000-0000-0000-00000000000b";
const LOCATION_A = "aaaaaaa0-0000-0000-0000-00000000000a";
const LOCATION_B = "aaaaaaa0-0000-0000-0000-00000000000b";
const LEVEL_A = "eeeeeee0-0000-0000-0000-00000000000a";
const LEVEL_B = "eeeeeee0-0000-0000-0000-00000000000b";
const CLASS_A = "fffffff0-0000-0000-0000-00000000000a";
const CLASS_B = "fffffff0-0000-0000-0000-00000000000b";
const SESSION_B = "55000000-0000-0000-0000-00000000000b";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations, families, students,
       class_levels, classes, enrolments, class_sessions, attendance
     RESTART IDENTITY CASCADE`,
  );

  await admin.$executeRaw`
    INSERT INTO users (id, email, name, updated_at) VALUES
      (${USER_A}::uuid, 'a@example.com', 'User A', now()),
      (${TEACHER_A}::uuid, 'teacher.a@example.com', 'Teacher A', now()),
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
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${TEACHER_A}::uuid, 'teacher', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (gen_random_uuid(), ${SCHOOL_B}::uuid, ${TEACHER_B}::uuid, 'teacher', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO locations (id, school_id, name, created_by, updated_by, updated_at) VALUES
      (${LOCATION_A}::uuid, ${SCHOOL_A}::uuid, 'A Pool', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${LOCATION_B}::uuid, ${SCHOOL_B}::uuid, 'B Pool', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO class_levels (id, school_id, name, ratio, order_index, created_by, updated_by, updated_at) VALUES
      (${LEVEL_A}::uuid, ${SCHOOL_A}::uuid, 'A Beg', 8, 0, ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${LEVEL_B}::uuid, ${SCHOOL_B}::uuid, 'B Beg', 8, 0, ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO classes (
      id, school_id, location_id, level_id, teacher_id,
      day_of_week, start_time, duration_minutes, capacity,
      created_by, updated_by, updated_at
    ) VALUES
      (${CLASS_A}::uuid, ${SCHOOL_A}::uuid, ${LOCATION_A}::uuid, ${LEVEL_A}::uuid, ${TEACHER_A}::uuid,
       'wednesday', '17:30:00', 30, 8, ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${CLASS_B}::uuid, ${SCHOOL_B}::uuid, ${LOCATION_B}::uuid, ${LEVEL_B}::uuid, ${TEACHER_B}::uuid,
       'wednesday', '17:30:00', 30, 8, ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO class_sessions (
      id, school_id, class_id, session_date, teacher_id,
      created_by, updated_by, updated_at
    ) VALUES
      (${SESSION_B}::uuid, ${SCHOOL_B}::uuid, ${CLASS_B}::uuid, '2026-04-01', ${TEACHER_B}::uuid,
       ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("class_sessions: cross-tenant isolation under RLS", () => {
  test("scoped to A: getById of B's session returns null", async () => {
    const found = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classSessionRepository.getById(tx, SESSION_B),
    );
    expect(found).toBeNull();
  });

  test("scoped to A: listByClass of B's class returns empty", async () => {
    const list = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        classSessionRepository.listByClass(tx, CLASS_B, {
          from: d("2026-03-01"),
          to: d("2026-05-01"),
        }),
    );
    expect(list).toHaveLength(0);
  });

  test("scoped to A: getOrCreateSession against B's class fails (RLS hides class lookup)", async () => {
    // RLS hides CLASS_B from school A's transaction. The repository's class
    // lookup returns null, surfacing NotFoundError rather than silently
    // creating a misowned row.
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        classSessionRepository.getOrCreateSession(tx, CLASS_B, d("2026-04-08")),
      ),
    ).rejects.toThrow(/class .* not found/);
  });

  test("scoped to A: direct INSERT with school_id = B is blocked by WITH CHECK", async () => {
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        tx.classSession.create({
          data: {
            schoolId: SCHOOL_B,
            classId: CLASS_B,
            sessionDate: d("2026-04-08"),
            teacherId: TEACHER_B,
            createdBy: USER_A,
            updatedBy: USER_A,
          },
        }),
      ),
    ).rejects.toThrow();

    const rowsB = await admin.classSession.findMany({ where: { schoolId: SCHOOL_B } });
    expect(rowsB).toHaveLength(1);
  });

  test("no tenant context: listByClass sees nothing (fail closed)", async () => {
    const list = await classSessionRepository.listByClass(prisma, CLASS_B, {
      from: d("2026-03-01"),
      to: d("2026-05-01"),
    });
    expect(list).toHaveLength(0);
  });
});
