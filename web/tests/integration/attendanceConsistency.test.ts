import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";

// Asserts the four legs of `app_assert_attendance_consistency`. We use the
// admin client throughout to bypass RLS — the trigger should still fire and
// raise check_violation. School A has all the right rows; school B exists
// only to provide cross-tenant ids to point at.

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
const FAMILY_A = "babababa-0000-0000-0000-00000000000a";
const FAMILY_B = "babababa-0000-0000-0000-00000000000b";
const STUDENT_A1 = "53000000-0000-0000-0000-00000000000a";
const STUDENT_A2 = "53000000-0000-0000-0000-00000000000c";
const STUDENT_B = "53000000-0000-0000-0000-00000000000b";

const ENROL_A1 = "ee000000-0000-0000-0000-00000000000a";
const ENROL_A2 = "ee000000-0000-0000-0000-00000000000c";
const ENROL_B = "ee000000-0000-0000-0000-00000000000b";
const SESSION_A = "55000000-0000-0000-0000-00000000000a";
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
    INSERT INTO families (id, school_id, primary_contact_name, primary_contact_email, created_by, updated_by, updated_at) VALUES
      (${FAMILY_A}::uuid, ${SCHOOL_A}::uuid, 'Family A', 'fam.a@example.com', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${FAMILY_B}::uuid, ${SCHOOL_B}::uuid, 'Family B', 'fam.b@example.com', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO students (id, school_id, family_id, first_name, last_name, date_of_birth, created_by, updated_by, updated_at) VALUES
      (${STUDENT_A1}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'Alice', 'A', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${STUDENT_A2}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'Carol', 'A', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${STUDENT_B}::uuid, ${SCHOOL_B}::uuid, ${FAMILY_B}::uuid, 'Bob', 'B', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO enrolments (
      id, school_id, student_id, class_id, frequency, start_date,
      created_by, updated_by, updated_at
    ) VALUES
      (${ENROL_A1}::uuid, ${SCHOOL_A}::uuid, ${STUDENT_A1}::uuid, ${CLASS_A}::uuid, 'weekly', '2026-04-01',
       ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${ENROL_A2}::uuid, ${SCHOOL_A}::uuid, ${STUDENT_A2}::uuid, ${CLASS_A}::uuid, 'weekly', '2026-04-01',
       ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${ENROL_B}::uuid, ${SCHOOL_B}::uuid, ${STUDENT_B}::uuid, ${CLASS_B}::uuid, 'weekly', '2026-04-01',
       ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO class_sessions (
      id, school_id, class_id, session_date, teacher_id,
      created_by, updated_by, updated_at
    ) VALUES
      (${SESSION_A}::uuid, ${SCHOOL_A}::uuid, ${CLASS_A}::uuid, '2026-04-01', ${TEACHER_A}::uuid,
       ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${SESSION_B}::uuid, ${SCHOOL_B}::uuid, ${CLASS_B}::uuid, '2026-04-01', ${TEACHER_B}::uuid,
       ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("attendance_consistency trigger", () => {
  test("attendance.school_id != enrolment.school_id is rejected", async () => {
    await expect(
      admin.$executeRaw`
        INSERT INTO attendance (
          school_id, class_session_id, enrolment_id, student_id, status,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${SESSION_A}::uuid, ${ENROL_B}::uuid, ${STUDENT_A1}::uuid,
          'present', ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/must match enrolment\.school_id/);
  });

  test("attendance.school_id != class_session.school_id is rejected", async () => {
    await expect(
      admin.$executeRaw`
        INSERT INTO attendance (
          school_id, class_session_id, enrolment_id, student_id, status,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${SESSION_B}::uuid, ${ENROL_A1}::uuid, ${STUDENT_A1}::uuid,
          'present', ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/must match (?:class_session|enrolment)\.school_id/);
  });

  test("attendance.school_id != student.school_id is rejected", async () => {
    await expect(
      admin.$executeRaw`
        INSERT INTO attendance (
          school_id, class_session_id, enrolment_id, student_id, status,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${SESSION_A}::uuid, ${ENROL_A1}::uuid, ${STUDENT_B}::uuid,
          'present', ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/must match (?:enrolment|student)/);
  });

  test("attendance.student_id != enrolment.student_id is rejected", async () => {
    // ENROL_A1 belongs to STUDENT_A1; pointing it at STUDENT_A2 (same school)
    // should still be rejected by the enrolment.student_id check.
    await expect(
      admin.$executeRaw`
        INSERT INTO attendance (
          school_id, class_session_id, enrolment_id, student_id, status,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${SESSION_A}::uuid, ${ENROL_A1}::uuid, ${STUDENT_A2}::uuid,
          'present', ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/must match enrolment\.student_id/);
  });

  test("happy path: matching school_id everywhere accepts", async () => {
    await admin.$executeRawUnsafe(`DELETE FROM attendance`);
    await admin.$executeRaw`
      INSERT INTO attendance (
        school_id, class_session_id, enrolment_id, student_id, status,
        created_by, updated_by, updated_at
      ) VALUES (
        ${SCHOOL_A}::uuid, ${SESSION_A}::uuid, ${ENROL_A1}::uuid, ${STUDENT_A1}::uuid,
        'present', ${USER_A}::uuid, ${USER_A}::uuid, now()
      )
    `;
    const rows = await admin.attendance.findMany({});
    expect(rows).toHaveLength(1);
  });
});
