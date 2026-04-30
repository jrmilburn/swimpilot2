import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as attendanceRepository from "../../src/repositories/attendanceRepository";
import * as classSessionRepository from "../../src/repositories/classSessionRepository";
import * as enrolmentRepository from "../../src/repositories/enrolmentRepository";
import {
  AttendanceStatus,
  EnrolmentFrequency,
} from "../../src/domain/enums";
import { ValidationError } from "../../src/lib/errors";

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
      (${STUDENT_A2}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'Bob', 'A', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

async function setupEnrolmentAndSession(date: string) {
  return withTenant({ schoolId: SCHOOL_A, userId: USER_A }, async (tx) => {
    const enrolA1 = await enrolmentRepository.create(tx, {
      studentId: STUDENT_A1,
      classId: CLASS_A,
      frequency: EnrolmentFrequency.Weekly,
      startDate: d("2026-04-01"),
    });
    const enrolA2 = await enrolmentRepository.create(tx, {
      studentId: STUDENT_A2,
      classId: CLASS_A,
      frequency: EnrolmentFrequency.Weekly,
      startDate: d("2026-04-01"),
    });
    const session = await classSessionRepository.getOrCreateSession(
      tx,
      CLASS_A,
      d(date),
    );
    return { enrolA1, enrolA2, session };
  });
}

async function reset() {
  await admin.$executeRawUnsafe(`DELETE FROM attendance`);
  await admin.$executeRawUnsafe(`DELETE FROM class_sessions`);
  await admin.$executeRawUnsafe(`DELETE FROM enrolments`);
}

describe("attendanceRepository.mark", () => {
  test("creates a fresh attendance row for present/late/absent", async () => {
    await reset();
    const { enrolA1, session } = await setupEnrolmentAndSession("2026-04-01");

    const present = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        attendanceRepository.mark(tx, {
          classSessionId: session.id,
          enrolmentId: enrolA1.id,
          studentId: STUDENT_A1,
          status: AttendanceStatus.Present,
        }),
    );
    expect(present.status).toBe(AttendanceStatus.Present);
    expect(present.classSessionId).toBe(session.id);
    expect(present.studentId).toBe(STUDENT_A1);

    const row = await admin.attendance.findUnique({ where: { id: present.id } });
    expect(row?.createdBy).toBe(USER_A);
  });

  test("upserts on (classSessionId, studentId) — second mark replaces status", async () => {
    await reset();
    const { enrolA1, session } = await setupEnrolmentAndSession("2026-04-08");

    const first = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        attendanceRepository.mark(tx, {
          classSessionId: session.id,
          enrolmentId: enrolA1.id,
          studentId: STUDENT_A1,
          status: AttendanceStatus.Present,
        }),
    );
    const second = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        attendanceRepository.mark(tx, {
          classSessionId: session.id,
          enrolmentId: enrolA1.id,
          studentId: STUDENT_A1,
          status: AttendanceStatus.Late,
          note: "arrived 10 min late",
        }),
    );
    expect(second.id).toBe(first.id);
    expect(second.status).toBe(AttendanceStatus.Late);
    expect(second.note).toBe("arrived 10 min late");

    const rows = await admin.attendance.findMany({
      where: { classSessionId: session.id, studentId: STUDENT_A1 },
    });
    expect(rows).toHaveLength(1);
  });

  test("rejects mark on a cancelled session with ValidationError", async () => {
    await reset();
    const { enrolA1, session } = await setupEnrolmentAndSession("2026-04-15");

    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
      classSessionRepository.cancel(tx, session.id, "pool closed"),
    );

    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        attendanceRepository.mark(tx, {
          classSessionId: session.id,
          enrolmentId: enrolA1.id,
          studentId: STUDENT_A1,
          status: AttendanceStatus.Present,
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("listBySession and listByStudent return rows scoped to inputs", async () => {
    await reset();
    const { enrolA1, enrolA2, session } = await setupEnrolmentAndSession("2026-04-22");

    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, async (tx) => {
      await attendanceRepository.mark(tx, {
        classSessionId: session.id,
        enrolmentId: enrolA1.id,
        studentId: STUDENT_A1,
        status: AttendanceStatus.Present,
      });
      await attendanceRepository.mark(tx, {
        classSessionId: session.id,
        enrolmentId: enrolA2.id,
        studentId: STUDENT_A2,
        status: AttendanceStatus.Absent,
      });
    });

    const bySession = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => attendanceRepository.listBySession(tx, session.id),
    );
    expect(bySession.map((a) => a.studentId).sort()).toEqual(
      [STUDENT_A1, STUDENT_A2].sort(),
    );

    const byStudent = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => attendanceRepository.listByStudent(tx, STUDENT_A1),
    );
    expect(byStudent).toHaveLength(1);
    expect(byStudent[0]!.status).toBe(AttendanceStatus.Present);

    const byStudentInRange = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        attendanceRepository.listByStudent(tx, STUDENT_A1, {
          from: d("2026-04-01"),
          to: d("2026-04-15"),
        }),
    );
    expect(byStudentInRange).toHaveLength(0);
  });
});
