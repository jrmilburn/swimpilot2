import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as enrolmentRepository from "../../src/repositories/enrolmentRepository";
import { EnrolmentFrequency } from "../../src/domain/enums";

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
const STUDENT_A = "53000000-0000-0000-0000-00000000000a";
const STUDENT_B = "53000000-0000-0000-0000-00000000000b";

const ENROL_A = "ee000000-0000-0000-0000-00000000000a";
const ENROL_B = "ee000000-0000-0000-0000-00000000000b";

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
      (${STUDENT_A}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'Alice', 'A', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${STUDENT_B}::uuid, ${SCHOOL_B}::uuid, ${FAMILY_B}::uuid, 'Bob', 'B', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO enrolments (
      id, school_id, student_id, class_id, frequency, start_date,
      created_by, updated_by, updated_at
    ) VALUES
      (${ENROL_A}::uuid, ${SCHOOL_A}::uuid, ${STUDENT_A}::uuid, ${CLASS_A}::uuid, 'weekly', '2026-04-01',
       ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${ENROL_B}::uuid, ${SCHOOL_B}::uuid, ${STUDENT_B}::uuid, ${CLASS_B}::uuid, 'weekly', '2026-04-01',
       ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("enrolments: cross-tenant isolation under RLS", () => {
  test("scoped to A: getById of B's enrolment returns null", async () => {
    const found = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => enrolmentRepository.getById(tx, ENROL_B),
    );
    expect(found).toBeNull();
  });

  test("scoped to A: listBySchool sees zero rows from B", async () => {
    const page = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => enrolmentRepository.listBySchool(tx),
    );
    expect(page.items.find((e) => e.id === ENROL_B)).toBeUndefined();
    expect(page.items.every((e) => e.schoolId === SCHOOL_A)).toBe(true);
  });

  test("scoped to A: create against B's student looks up nothing → NotFoundError", async () => {
    // RLS scopes the student lookup; STUDENT_B is invisible. enrolmentRepository
    // matches the studentRepository pattern of throwing NotFoundError, not
    // leaking that the row exists.
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        enrolmentRepository.create(tx, {
          studentId: STUDENT_B,
          classId: CLASS_A,
          frequency: EnrolmentFrequency.Weekly,
          startDate: d("2026-04-01"),
        }),
      ),
    ).rejects.toThrow(/student .* not found/);
  });

  test("scoped to A: create with classId from B is blocked by consistency trigger", async () => {
    // RLS hides STUDENT_B, so we use STUDENT_A but pair with CLASS_B. The
    // student lookup succeeds (school A), classId references B → school_id
    // mismatch caught by enrolments_consistency.
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        enrolmentRepository.create(tx, {
          studentId: STUDENT_A,
          classId: CLASS_B,
          frequency: EnrolmentFrequency.Weekly,
          startDate: d("2026-04-01"),
        }),
      ),
    ).rejects.toThrow();
  });

  test("scoped to A: direct INSERT with school_id = B is blocked by WITH CHECK", async () => {
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        tx.enrolment.create({
          data: {
            schoolId: SCHOOL_B,
            studentId: STUDENT_B,
            classId: CLASS_B,
            frequency: "weekly",
            startDate: d("2026-04-01"),
            createdBy: USER_A,
            updatedBy: USER_A,
          },
        }),
      ),
    ).rejects.toThrow();

    // Confirm only the seeded B enrolment exists.
    const rowsB = await admin.enrolment.findMany({ where: { schoolId: SCHOOL_B } });
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]?.id).toBe(ENROL_B);
  });

  test("no tenant context: listBySchool sees nothing (fail closed)", async () => {
    const page = await enrolmentRepository.listBySchool(prisma);
    expect(page.items).toHaveLength(0);
  });
});
