import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const SCHOOL_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const STRANGER = "ddddddd0-0000-0000-0000-00000000aaaa";
const LOCATION_A = "aaaaaaa0-0000-0000-0000-00000000000a";
const LOCATION_B = "aaaaaaa0-0000-0000-0000-00000000000b";
const LEVEL_A = "eeeeeee0-0000-0000-0000-00000000000a";
const LEVEL_B = "eeeeeee0-0000-0000-0000-00000000000b";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations, families, students, class_levels, classes RESTART IDENTITY CASCADE`,
  );

  await admin.$executeRaw`
    INSERT INTO users (id, email, name, updated_at) VALUES
      (${USER_A}::uuid, 'admin@example.com', 'Admin', now()),
      (${STRANGER}::uuid, 'stranger@example.com', 'Stranger', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${SCHOOL_A}::uuid, 'school-a', 'School A', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${SCHOOL_B}::uuid, 'school-b', 'School B', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO locations (id, school_id, name, created_by, updated_by, updated_at) VALUES
      (${LOCATION_A}::uuid, ${SCHOOL_A}::uuid, 'A Pool', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${LOCATION_B}::uuid, ${SCHOOL_B}::uuid, 'B Pool', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO class_levels (id, school_id, name, ratio, order_index, created_by, updated_by, updated_at) VALUES
      (${LEVEL_A}::uuid, ${SCHOOL_A}::uuid, 'A Infants', 4, 0, ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${LEVEL_B}::uuid, ${SCHOOL_B}::uuid, 'B Infants', 4, 0, ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("classes_consistency trigger", () => {
  test("class with location_id from another school raises", async () => {
    // Use admin so RLS doesn't pre-empt the trigger; we want to prove the
    // trigger itself catches a cross-school location.
    await expect(
      admin.$executeRaw`
        INSERT INTO classes (
          school_id, location_id, level_id, day_of_week, start_time,
          duration_minutes, capacity, created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${LOCATION_B}::uuid, ${LEVEL_A}::uuid, 'monday', '16:00',
          30, 4, ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/must match location\.school_id/);
  });

  test("class with level_id from another school raises", async () => {
    await expect(
      admin.$executeRaw`
        INSERT INTO classes (
          school_id, location_id, level_id, day_of_week, start_time,
          duration_minutes, capacity, created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${LOCATION_A}::uuid, ${LEVEL_B}::uuid, 'monday', '16:00',
          30, 4, ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/must match level\.school_id/);
  });

  test("class with teacher_id who is not a member of the school raises", async () => {
    await expect(
      admin.$executeRaw`
        INSERT INTO classes (
          school_id, location_id, level_id, teacher_id,
          day_of_week, start_time, duration_minutes, capacity,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${LOCATION_A}::uuid, ${LEVEL_A}::uuid, ${STRANGER}::uuid,
          'monday', '16:00', 30, 4,
          ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/is not a member of school/);
  });

  test("class with teacher_id whose membership is soft-deleted raises", async () => {
    // Add a soft-deleted membership to assert the deleted_at IS NULL clause.
    await admin.$executeRaw`
      INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at, deleted_at) VALUES
        (gen_random_uuid(), ${SCHOOL_A}::uuid, ${STRANGER}::uuid, 'teacher', ${USER_A}::uuid, ${USER_A}::uuid, now(), now())
    `;
    await expect(
      admin.$executeRaw`
        INSERT INTO classes (
          school_id, location_id, level_id, teacher_id,
          day_of_week, start_time, duration_minutes, capacity,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${LOCATION_A}::uuid, ${LEVEL_A}::uuid, ${STRANGER}::uuid,
          'tuesday', '16:00', 30, 4,
          ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/is not a member of school/);
    await admin.$executeRawUnsafe(`DELETE FROM memberships WHERE user_id = '${STRANGER}'`);
  });

  test("UPDATE that desyncs school_id from location raises", async () => {
    // Insert a valid class, then try to flip its school_id alone.
    await admin.$executeRaw`
      INSERT INTO classes (
        school_id, location_id, level_id, day_of_week, start_time,
        duration_minutes, capacity, created_by, updated_by, updated_at
      ) VALUES (
        ${SCHOOL_A}::uuid, ${LOCATION_A}::uuid, ${LEVEL_A}::uuid, 'wednesday', '16:00',
        30, 4, ${USER_A}::uuid, ${USER_A}::uuid, now()
      )
    `;
    const inserted = await admin.class.findFirst({
      where: { schoolId: SCHOOL_A, dayOfWeek: "wednesday" },
    });
    expect(inserted).not.toBeNull();
    await expect(
      admin.$executeRaw`
        UPDATE classes SET school_id = ${SCHOOL_B}::uuid WHERE id = ${inserted!.id}::uuid
      `,
    ).rejects.toThrow(/must match (?:location|level)\.school_id/);
    await admin.$executeRawUnsafe(`DELETE FROM classes`);
  });
});
