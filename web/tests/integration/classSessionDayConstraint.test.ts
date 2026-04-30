import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";

// The class_sessions_consistency trigger must reject any session_date whose
// day-of-week doesn't match the parent class's day_of_week. We bypass RLS
// (admin client) and the application's getOrCreateSession helper to assert
// the trigger directly — the helper only ever passes class-derived dates,
// so this is the layer that catches a programmer error.

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const TEACHER_A = "ddddddd0-0000-0000-0000-00000000000a";
const LOCATION_A = "aaaaaaa0-0000-0000-0000-00000000000a";
const LEVEL_A = "eeeeeee0-0000-0000-0000-00000000000a";
const CLASS_WED = "fffffff0-0000-0000-0000-00000000000a";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations, families, students,
       class_levels, classes, enrolments, class_sessions, attendance
     RESTART IDENTITY CASCADE`,
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
  await admin.$executeRaw`
    INSERT INTO class_levels (id, school_id, name, ratio, order_index, created_by, updated_by, updated_at) VALUES
      (${LEVEL_A}::uuid, ${SCHOOL_A}::uuid, 'Beginner', 8, 0, ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO classes (
      id, school_id, location_id, level_id, teacher_id,
      day_of_week, start_time, duration_minutes, capacity,
      created_by, updated_by, updated_at
    ) VALUES (
      ${CLASS_WED}::uuid, ${SCHOOL_A}::uuid, ${LOCATION_A}::uuid, ${LEVEL_A}::uuid, ${TEACHER_A}::uuid,
      'wednesday', '17:30:00', 30, 8,
      ${USER_A}::uuid, ${USER_A}::uuid, now()
    )
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("class_sessions_consistency: day-of-week must match", () => {
  test("Tuesday session_date on a Wednesday class is rejected", async () => {
    // 2026-04-07 is a Tuesday.
    await expect(
      admin.$executeRaw`
        INSERT INTO class_sessions (
          school_id, class_id, session_date, teacher_id,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${CLASS_WED}::uuid, '2026-04-07'::date, ${TEACHER_A}::uuid,
          ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/must fall on class\.day_of_week/);
  });

  test("Wednesday session_date on a Wednesday class is accepted", async () => {
    await admin.$executeRawUnsafe(`DELETE FROM class_sessions`);
    // 2026-04-08 is a Wednesday.
    await admin.$executeRaw`
      INSERT INTO class_sessions (
        school_id, class_id, session_date, teacher_id,
        created_by, updated_by, updated_at
      ) VALUES (
        ${SCHOOL_A}::uuid, ${CLASS_WED}::uuid, '2026-04-08'::date, ${TEACHER_A}::uuid,
        ${USER_A}::uuid, ${USER_A}::uuid, now()
      )
    `;
    const rows = await admin.classSession.findMany({ where: { classId: CLASS_WED } });
    expect(rows).toHaveLength(1);
  });

  test("UPDATE that moves a session to a Tuesday is rejected", async () => {
    await admin.$executeRawUnsafe(`DELETE FROM class_sessions`);
    await admin.$executeRaw`
      INSERT INTO class_sessions (
        school_id, class_id, session_date, teacher_id,
        created_by, updated_by, updated_at
      ) VALUES (
        ${SCHOOL_A}::uuid, ${CLASS_WED}::uuid, '2026-04-15'::date, ${TEACHER_A}::uuid,
        ${USER_A}::uuid, ${USER_A}::uuid, now()
      )
    `;
    const row = await admin.classSession.findFirst({ where: { classId: CLASS_WED } });
    expect(row).not.toBeNull();
    await expect(
      admin.$executeRaw`
        UPDATE class_sessions SET session_date = '2026-04-14'::date WHERE id = ${row!.id}::uuid
      `,
    ).rejects.toThrow(/must fall on class\.day_of_week/);
  });
});
