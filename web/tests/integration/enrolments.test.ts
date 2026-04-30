import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as enrolmentRepository from "../../src/repositories/enrolmentRepository";
import {
  EnrolmentFrequency,
  EnrolmentStatus,
} from "../../src/domain/enums";

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
const STUDENT_A1 = "53000000-0000-0000-0000-00000000000a";
const STUDENT_A2 = "53000000-0000-0000-0000-00000000000b";
const STUDENT_A3 = "53000000-0000-0000-0000-00000000000c";

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
      (${STUDENT_A1}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'Alice', 'A', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${STUDENT_A2}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'Bob', 'A', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${STUDENT_A3}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'Carol', 'A', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("enrolmentRepository", () => {
  test("create + getById round-trips for each frequency", async () => {
    const result = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      async (tx) => {
        const weekly = await enrolmentRepository.create(tx, {
          studentId: STUDENT_A1,
          classId: CLASS_A,
          frequency: EnrolmentFrequency.Weekly,
          startDate: d("2026-04-01"),
        });
        const fortA = await enrolmentRepository.create(tx, {
          studentId: STUDENT_A2,
          classId: CLASS_A,
          frequency: EnrolmentFrequency.FortnightlyA,
          startDate: d("2026-04-01"),
        });
        const fortB = await enrolmentRepository.create(tx, {
          studentId: STUDENT_A3,
          classId: CLASS_A,
          frequency: EnrolmentFrequency.FortnightlyB,
          startDate: d("2026-04-01"),
        });
        const oneOff = await enrolmentRepository.create(tx, {
          studentId: STUDENT_A1,
          classId: CLASS_A,
          frequency: EnrolmentFrequency.OneOff,
          startDate: d("2026-04-15"),
          endDate: d("2026-04-15"),
          notes: "trial",
        });
        return { weekly, fortA, fortB, oneOff };
      },
    );

    expect(result.weekly.frequency).toBe(EnrolmentFrequency.Weekly);
    expect(result.weekly.status).toBe(EnrolmentStatus.Active);
    expect(result.fortA.frequency).toBe(EnrolmentFrequency.FortnightlyA);
    expect(result.fortB.frequency).toBe(EnrolmentFrequency.FortnightlyB);
    expect(result.oneOff.frequency).toBe(EnrolmentFrequency.OneOff);
    expect(result.oneOff.notes).toBe("trial");

    const fetched = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => enrolmentRepository.getById(tx, result.weekly.id),
    );
    expect(fetched?.id).toBe(result.weekly.id);

    const row = await admin.enrolment.findUnique({ where: { id: result.weekly.id } });
    expect(row?.createdBy).toBe(USER_A);
  });

  test("listByStudent / listByClass / listBySchool", async () => {
    await admin.$executeRawUnsafe(`DELETE FROM enrolments`);

    const ids = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      async (tx) => {
        const a = await enrolmentRepository.create(tx, {
          studentId: STUDENT_A1,
          classId: CLASS_A,
          frequency: EnrolmentFrequency.Weekly,
          startDate: d("2026-04-01"),
        });
        const b = await enrolmentRepository.create(tx, {
          studentId: STUDENT_A2,
          classId: CLASS_A,
          frequency: EnrolmentFrequency.Weekly,
          startDate: d("2026-04-08"),
        });
        return { a, b };
      },
    );

    const byStudent = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => enrolmentRepository.listByStudent(tx, STUDENT_A1),
    );
    expect(byStudent.map((e) => e.id)).toEqual([ids.a.id]);

    const byClass = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => enrolmentRepository.listByClass(tx, CLASS_A),
    );
    expect(byClass.map((e) => e.id).sort()).toEqual([ids.a.id, ids.b.id].sort());

    const page = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => enrolmentRepository.listBySchool(tx),
    );
    expect(page.items).toHaveLength(2);
  });

  test("pause / resume / withdraw transitions", async () => {
    await admin.$executeRawUnsafe(`DELETE FROM enrolments`);

    const created = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        enrolmentRepository.create(tx, {
          studentId: STUDENT_A1,
          classId: CLASS_A,
          frequency: EnrolmentFrequency.Weekly,
          startDate: d("2026-04-01"),
        }),
    );
    expect(created.status).toBe(EnrolmentStatus.Active);

    const paused = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        enrolmentRepository.pause(tx, created.id, d("2026-05-01"), d("2026-05-15")),
    );
    expect(paused.status).toBe(EnrolmentStatus.Paused);
    expect(paused.pauseFrom).toEqual(d("2026-05-01"));
    expect(paused.pauseTo).toEqual(d("2026-05-15"));

    const resumed = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => enrolmentRepository.resume(tx, created.id),
    );
    expect(resumed.status).toBe(EnrolmentStatus.Active);
    expect(resumed.pauseFrom).toBeNull();
    expect(resumed.pauseTo).toBeNull();

    // Idempotent: calling resume on an already-active enrolment is a no-op
    // beyond bumping updated_at.
    const resumedAgain = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => enrolmentRepository.resume(tx, created.id),
    );
    expect(resumedAgain.status).toBe(EnrolmentStatus.Active);

    const withdrawn = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => enrolmentRepository.withdraw(tx, created.id, d("2026-06-01")),
    );
    expect(withdrawn.status).toBe(EnrolmentStatus.Withdrawn);
    expect(withdrawn.endDate).toEqual(d("2026-06-01"));
  });

  test("update mutates fields and stamps updated_by", async () => {
    await admin.$executeRawUnsafe(`DELETE FROM enrolments`);

    const created = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        enrolmentRepository.create(tx, {
          studentId: STUDENT_A1,
          classId: CLASS_A,
          frequency: EnrolmentFrequency.Weekly,
          startDate: d("2026-04-01"),
        }),
    );

    const updated = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        enrolmentRepository.update(tx, created.id, {
          notes: "needs makeup",
          frequency: EnrolmentFrequency.FortnightlyA,
        }),
    );
    expect(updated.notes).toBe("needs makeup");
    expect(updated.frequency).toBe(EnrolmentFrequency.FortnightlyA);

    const row = await admin.enrolment.findUnique({ where: { id: created.id } });
    expect(row?.updatedBy).toBe(USER_A);
  });
});
