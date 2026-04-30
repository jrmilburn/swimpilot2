import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const SCHOOL_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const FAMILY_A = "ddddddd0-0000-0000-0000-000000000001";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations, families, students RESTART IDENTITY CASCADE`,
  );

  await admin.$executeRaw`
    INSERT INTO users (id, email, name, updated_at) VALUES
      (${USER_A}::uuid, 'a@example.com', 'User A', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${SCHOOL_A}::uuid, 'school-a', 'School A', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${SCHOOL_B}::uuid, 'school-b', 'School B', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO families (id, school_id, primary_contact_name, primary_contact_email, created_by, updated_by, updated_at) VALUES
      (${FAMILY_A}::uuid, ${SCHOOL_A}::uuid, 'Tenant A Family', 'a@example.com', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("students_school_matches_family trigger", () => {
  test("INSERT with mismatched school_id raises check_violation", async () => {
    // Use admin so RLS doesn't pre-empt the trigger; we want to prove the
    // trigger itself catches a school_id that disagrees with the family.
    await expect(
      admin.$executeRaw`
        INSERT INTO students (school_id, family_id, first_name, last_name, date_of_birth, created_by, updated_by, updated_at)
        VALUES (${SCHOOL_B}::uuid, ${FAMILY_A}::uuid, 'Bad', 'Child', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now())
      `,
    ).rejects.toThrow(/must match family.school_id/);

    // Nothing got in.
    const rows = await admin.student.findMany();
    expect(rows).toHaveLength(0);
  });

  test("UPDATE that desyncs school_id raises check_violation", async () => {
    // First insert a valid student, then try to flip its school_id alone.
    await admin.$executeRaw`
      INSERT INTO students (school_id, family_id, first_name, last_name, date_of_birth, created_by, updated_by, updated_at)
      VALUES (${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'Mia', 'A', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now())
    `;
    const inserted = await admin.student.findFirst({ where: { firstName: "Mia" } });
    expect(inserted).not.toBeNull();

    await expect(
      admin.$executeRaw`
        UPDATE students SET school_id = ${SCHOOL_B}::uuid WHERE id = ${inserted!.id}::uuid
      `,
    ).rejects.toThrow(/must match family.school_id/);

    // Cleanup so other tests in this file (if added) start clean.
    await admin.$executeRawUnsafe(`DELETE FROM students`);
  });
});
