import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as classSessionRepository from "../../src/repositories/classSessionRepository";
import { ClassSessionStatus } from "../../src/domain/enums";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const TEACHER_A1 = "ddddddd0-0000-0000-0000-00000000000a";
const TEACHER_A2 = "ddddddd0-0000-0000-0000-00000000000b";
const LOCATION_A = "aaaaaaa0-0000-0000-0000-00000000000a";
const LEVEL_A = "eeeeeee0-0000-0000-0000-00000000000a";
const CLASS_A = "fffffff0-0000-0000-0000-00000000000a";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations, families, students,
       class_levels, classes, enrolments, class_sessions, attendance
     RESTART IDENTITY CASCADE`,
  );

  await admin.$executeRaw`
    INSERT INTO users (id, email, name, updated_at) VALUES
      (${USER_A}::uuid, 'a@example.com', 'User A', now()),
      (${TEACHER_A1}::uuid, 'teacher1@example.com', 'Teacher One', now()),
      (${TEACHER_A2}::uuid, 'teacher2@example.com', 'Teacher Two', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${SCHOOL_A}::uuid, 'school-a', 'School A', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${USER_A}::uuid, 'owner', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${TEACHER_A1}::uuid, 'teacher', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${TEACHER_A2}::uuid, 'teacher', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO locations (id, school_id, name, created_by, updated_by, updated_at) VALUES
      (${LOCATION_A}::uuid, ${SCHOOL_A}::uuid, 'Pool', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO class_levels (id, school_id, name, ratio, order_index, created_by, updated_by, updated_at) VALUES
      (${LEVEL_A}::uuid, ${SCHOOL_A}::uuid, 'Beginner', 8, 0, ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  // Wednesday class so 2026-04-01 (a Wednesday) is a valid session_date.
  await admin.$executeRaw`
    INSERT INTO classes (
      id, school_id, location_id, level_id, teacher_id,
      day_of_week, start_time, duration_minutes, capacity,
      created_by, updated_by, updated_at
    ) VALUES (
      ${CLASS_A}::uuid, ${SCHOOL_A}::uuid, ${LOCATION_A}::uuid, ${LEVEL_A}::uuid, ${TEACHER_A1}::uuid,
      'wednesday', '17:30:00', 30, 8,
      ${USER_A}::uuid, ${USER_A}::uuid, now()
    )
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("classSessionRepository.getOrCreateSession", () => {
  test("creates a session row and snapshots the class teacher", async () => {
    await admin.$executeRawUnsafe(`DELETE FROM class_sessions`);

    const session = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classSessionRepository.getOrCreateSession(tx, CLASS_A, d("2026-04-01")),
    );
    expect(session.classId).toBe(CLASS_A);
    expect(session.sessionDate).toEqual(d("2026-04-01"));
    expect(session.teacherId).toBe(TEACHER_A1);
    expect(session.status).toBe(ClassSessionStatus.Scheduled);

    const row = await admin.classSession.findUnique({ where: { id: session.id } });
    expect(row?.createdBy).toBe(USER_A);
  });

  test("idempotent: second call returns the same row, no duplicate", async () => {
    await admin.$executeRawUnsafe(`DELETE FROM class_sessions`);

    const first = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classSessionRepository.getOrCreateSession(tx, CLASS_A, d("2026-04-08")),
    );
    const second = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classSessionRepository.getOrCreateSession(tx, CLASS_A, d("2026-04-08")),
    );
    expect(second.id).toBe(first.id);

    const rows = await admin.classSession.findMany({
      where: { classId: CLASS_A, sessionDate: d("2026-04-08") },
    });
    expect(rows).toHaveLength(1);
  });

  test("teacher snapshot is frozen: reassigning the class teacher does not update existing session rows", async () => {
    await admin.$executeRawUnsafe(`DELETE FROM class_sessions`);

    const session = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classSessionRepository.getOrCreateSession(tx, CLASS_A, d("2026-04-15")),
    );
    expect(session.teacherId).toBe(TEACHER_A1);

    // Reassign the class to a new teacher.
    await admin.$executeRaw`
      UPDATE classes SET teacher_id = ${TEACHER_A2}::uuid WHERE id = ${CLASS_A}::uuid
    `;

    const reread = await admin.classSession.findUnique({ where: { id: session.id } });
    expect(reread?.teacherId).toBe(TEACHER_A1);

    // A *new* session for a different date picks up the new teacher.
    const fresh = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classSessionRepository.getOrCreateSession(tx, CLASS_A, d("2026-04-22")),
    );
    expect(fresh.teacherId).toBe(TEACHER_A2);

    // Restore for downstream tests.
    await admin.$executeRaw`
      UPDATE classes SET teacher_id = ${TEACHER_A1}::uuid WHERE id = ${CLASS_A}::uuid
    `;
  });

  test("listByClass scopes to the date range", async () => {
    await admin.$executeRawUnsafe(`DELETE FROM class_sessions`);

    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, async (tx) => {
      await classSessionRepository.getOrCreateSession(tx, CLASS_A, d("2026-04-01"));
      await classSessionRepository.getOrCreateSession(tx, CLASS_A, d("2026-04-08"));
      await classSessionRepository.getOrCreateSession(tx, CLASS_A, d("2026-04-15"));
    });

    const inRange = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        classSessionRepository.listByClass(tx, CLASS_A, {
          from: d("2026-04-01"),
          to: d("2026-04-08"),
        }),
    );
    expect(inRange.map((s) => s.sessionDate)).toEqual([
      d("2026-04-01"),
      d("2026-04-08"),
    ]);
  });

  test("cancel and markCompleted transition the status", async () => {
    await admin.$executeRawUnsafe(`DELETE FROM class_sessions`);

    const session = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classSessionRepository.getOrCreateSession(tx, CLASS_A, d("2026-04-29")),
    );
    expect(session.status).toBe(ClassSessionStatus.Scheduled);

    const cancelled = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classSessionRepository.cancel(tx, session.id, "pool closed"),
    );
    expect(cancelled.status).toBe(ClassSessionStatus.Cancelled);
    expect(cancelled.cancellationReason).toBe("pool closed");

    const fresh = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classSessionRepository.getOrCreateSession(tx, CLASS_A, d("2026-05-06")),
    );
    const completed = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => classSessionRepository.markCompleted(tx, fresh.id),
    );
    expect(completed.status).toBe(ClassSessionStatus.Completed);
  });
});
