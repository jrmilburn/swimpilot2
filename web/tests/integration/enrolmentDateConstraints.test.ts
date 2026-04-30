import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";

// Asserts the four DB-level CHECK constraints on `enrolments`. We bypass the
// repository (and thus RLS) by inserting through admin so the test isolates
// the constraint behaviour itself.

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const TEACHER_A = "ddddddd0-0000-0000-0000-00000000000a";
const LOCATION_A = "aaaaaaa0-0000-0000-0000-00000000000a";
const LEVEL_A = "eeeeeee0-0000-0000-0000-00000000000a";
const CLASS_A = "fffffff0-0000-0000-0000-00000000000a";
const FAMILY_A = "babababa-0000-0000-0000-00000000000a";
const STUDENT_A = "53000000-0000-0000-0000-00000000000a";

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
      ${CLASS_A}::uuid, ${SCHOOL_A}::uuid, ${LOCATION_A}::uuid, ${LEVEL_A}::uuid, ${TEACHER_A}::uuid,
      'wednesday', '17:30:00', 30, 8,
      ${USER_A}::uuid, ${USER_A}::uuid, now()
    )
  `;
  await admin.$executeRaw`
    INSERT INTO families (id, school_id, primary_contact_name, primary_contact_email, created_by, updated_by, updated_at) VALUES
      (${FAMILY_A}::uuid, ${SCHOOL_A}::uuid, 'Family A', 'fam.a@example.com', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO students (id, school_id, family_id, first_name, last_name, date_of_birth, created_by, updated_by, updated_at) VALUES
      (${STUDENT_A}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'Alice', 'A', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

async function insertEnrolment(values: {
  frequency: string;
  startDate: string;
  endDate?: string | null;
  pauseFrom?: string | null;
  pauseTo?: string | null;
  status?: string;
}): Promise<void> {
  await admin.$executeRawUnsafe(
    `INSERT INTO enrolments (
       school_id, student_id, class_id,
       frequency, start_date, end_date, pause_from, pause_to,
       status, created_by, updated_by, updated_at
     ) VALUES (
       '${SCHOOL_A}'::uuid, '${STUDENT_A}'::uuid, '${CLASS_A}'::uuid,
       '${values.frequency}'::enrolment_frequency,
       '${values.startDate}'::date,
       ${values.endDate ? `'${values.endDate}'::date` : "NULL"},
       ${values.pauseFrom ? `'${values.pauseFrom}'::date` : "NULL"},
       ${values.pauseTo ? `'${values.pauseTo}'::date` : "NULL"},
       '${values.status ?? "active"}'::enrolment_status,
       '${USER_A}'::uuid, '${USER_A}'::uuid, now()
     )`,
  );
}

describe("enrolments date / pause CHECK constraints", () => {
  test("pause_from set with pause_to NULL is rejected", async () => {
    await expect(
      insertEnrolment({
        frequency: "weekly",
        startDate: "2026-04-01",
        pauseFrom: "2026-05-01",
        pauseTo: null,
      }),
    ).rejects.toThrow(/pause_both_or_neither/);
  });

  test("pause_to NULL with pause_from set (mirror) is rejected", async () => {
    await expect(
      insertEnrolment({
        frequency: "weekly",
        startDate: "2026-04-01",
        pauseFrom: null,
        pauseTo: "2026-05-15",
      }),
    ).rejects.toThrow(/pause_both_or_neither/);
  });

  test("pause_to before pause_from is rejected", async () => {
    await expect(
      insertEnrolment({
        frequency: "weekly",
        startDate: "2026-04-01",
        pauseFrom: "2026-05-15",
        pauseTo: "2026-05-01",
      }),
    ).rejects.toThrow(/pause_window/);
  });

  test("end_date before start_date is rejected", async () => {
    await expect(
      insertEnrolment({
        frequency: "weekly",
        startDate: "2026-04-15",
        endDate: "2026-04-01",
      }),
    ).rejects.toThrow(/end_after_start/);
  });

  test("one_off with end_date != start_date is rejected", async () => {
    await expect(
      insertEnrolment({
        frequency: "one_off",
        startDate: "2026-04-01",
        endDate: "2026-04-08",
      }),
    ).rejects.toThrow(/one_off_dates/);
  });

  test("status='paused' with no pause_from is rejected", async () => {
    await expect(
      insertEnrolment({
        frequency: "weekly",
        startDate: "2026-04-01",
        status: "paused",
      }),
    ).rejects.toThrow(/paused_requires_pause_dates/);
  });

  test("valid pause window and one_off accept", async () => {
    await admin.$executeRawUnsafe(`DELETE FROM enrolments`);
    await insertEnrolment({
      frequency: "weekly",
      startDate: "2026-04-01",
      pauseFrom: "2026-05-01",
      pauseTo: "2026-05-15",
    });
    await insertEnrolment({
      frequency: "one_off",
      startDate: "2026-04-15",
      endDate: "2026-04-15",
    });
    const rows = await admin.enrolment.findMany({});
    expect(rows).toHaveLength(2);
    await admin.$executeRawUnsafe(`DELETE FROM enrolments`);
  });
});
