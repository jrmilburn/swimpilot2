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
const FAMILY_A2 = "babababa-0000-0000-0000-00000000001a";
const FAMILY_B = "babababa-0000-0000-0000-00000000000b";
const STUDENT_A = "53000000-0000-0000-0000-00000000000a";
const STUDENT_A2 = "53000000-0000-0000-0000-00000000001a";

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
      (${FAMILY_A}::uuid,  ${SCHOOL_A}::uuid, 'Family A',  'fam.a@example.com',  ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${FAMILY_A2}::uuid, ${SCHOOL_A}::uuid, 'Family A2', 'fam.a2@example.com', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${FAMILY_B}::uuid,  ${SCHOOL_B}::uuid, 'Family B',  'fam.b@example.com',  ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  // STUDENT_A belongs to FAMILY_A; STUDENT_A2 belongs to FAMILY_A2 (same school).
  await admin.$executeRaw`
    INSERT INTO students (id, school_id, family_id, first_name, last_name, date_of_birth, created_by, updated_by, updated_at) VALUES
      (${STUDENT_A}::uuid,  ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid,  'Alice', 'A', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${STUDENT_A2}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A2}::uuid, 'Andy',  'A', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("credits: consistency trigger and CHECK constraints", () => {
  test("credit with family_id from another school raises", async () => {
    await expect(
      admin.$executeRaw`
        INSERT INTO credits (
          school_id, family_id, amount_cents, source,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${FAMILY_B}::uuid, 1000, 'manual'::credit_source,
          ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/must match family\.school_id/);
  });

  test("student-level credit where student.family_id != credit.family_id raises", async () => {
    // STUDENT_A2 belongs to FAMILY_A2, but we attribute the credit to FAMILY_A.
    await expect(
      admin.$executeRaw`
        INSERT INTO credits (
          school_id, family_id, student_id, amount_cents, source,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, ${STUDENT_A2}::uuid,
          1000, 'manual'::credit_source,
          ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/must match student\.family_id/);
  });

  test("status='applied' without applied_to_invoice_id is rejected", async () => {
    await expect(
      admin.$executeRaw`
        INSERT INTO credits (
          school_id, family_id, amount_cents, source, status,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 1000, 'manual'::credit_source,
          'applied'::credit_status,
          ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/credits_applied_consistency_check/);
  });

  test("amount_cents <= 0 is rejected", async () => {
    await expect(
      admin.$executeRaw`
        INSERT INTO credits (
          school_id, family_id, amount_cents, source,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 0, 'manual'::credit_source,
          ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/credits_amount_positive_check/);
  });

  test("a valid family-level credit writes successfully", async () => {
    await admin.$executeRaw`
      INSERT INTO credits (
        school_id, family_id, amount_cents, source,
        created_by, updated_by, updated_at
      ) VALUES (
        ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 2500,
        'school_cancellation'::credit_source,
        ${USER_A}::uuid, ${USER_A}::uuid, now()
      )
    `;
    const credit = await admin.credit.findFirst({
      where: { familyId: FAMILY_A, amountCents: 2500 },
    });
    expect(credit?.status).toBe("available");
  });

  test("a valid student-level credit writes successfully", async () => {
    await admin.$executeRaw`
      INSERT INTO credits (
        school_id, family_id, student_id, amount_cents, source,
        created_by, updated_by, updated_at
      ) VALUES (
        ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, ${STUDENT_A}::uuid, 1500,
        'notified_absence'::credit_source,
        ${USER_A}::uuid, ${USER_A}::uuid, now()
      )
    `;
    const credit = await admin.credit.findFirst({
      where: { studentId: STUDENT_A, amountCents: 1500 },
    });
    expect(credit?.familyId).toBe(FAMILY_A);
  });
});
