import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const SCHOOL_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const FAMILY_A = "babababa-0000-0000-0000-00000000000a";
const FAMILY_B = "babababa-0000-0000-0000-00000000000b";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations, families, students,
       class_levels, classes, enrolments, class_sessions, attendance,
       skills, student_skills,
       billing_profiles, invoices, invoice_lines, credits, billing_counters
     RESTART IDENTITY CASCADE`,
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
      (${FAMILY_A}::uuid, ${SCHOOL_A}::uuid, 'Family A', 'fam.a@example.com', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${FAMILY_B}::uuid, ${SCHOOL_B}::uuid, 'Family B', 'fam.b@example.com', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("billing_profiles_consistency trigger", () => {
  test("billing_profile with family_id from another school raises", async () => {
    await expect(
      admin.$executeRaw`
        INSERT INTO billing_profiles (
          school_id, family_id, billing_frequency, billing_anchor_date,
          payment_method_type, created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${FAMILY_B}::uuid, 'weekly'::billing_frequency,
          '2026-05-04'::date, 'card'::payment_method_type,
          ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/must match family\.school_id/);
  });

  test("UPDATE that desyncs school_id from family raises", async () => {
    // Insert a valid profile first, then try to flip its school_id.
    await admin.$executeRaw`
      INSERT INTO billing_profiles (
        school_id, family_id, billing_frequency, billing_anchor_date,
        payment_method_type, created_by, updated_by, updated_at
      ) VALUES (
        ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'weekly'::billing_frequency,
        '2026-05-04'::date, 'card'::payment_method_type,
        ${USER_A}::uuid, ${USER_A}::uuid, now()
      )
    `;

    await expect(
      admin.$executeRaw`
        UPDATE billing_profiles
        SET school_id = ${SCHOOL_B}::uuid
        WHERE family_id = ${FAMILY_A}::uuid
      `,
    ).rejects.toThrow(/must match family\.school_id/);
  });
});
