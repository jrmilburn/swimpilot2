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
const STUDENT_A = "53000000-0000-0000-0000-00000000000a";
const STUDENT_B = "53000000-0000-0000-0000-00000000000b";
const INVOICE_A = "1c000000-0000-0000-0000-00000000000a";
const INVOICE_B = "1c000000-0000-0000-0000-00000000000b";

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
  await admin.$executeRaw`
    INSERT INTO students (id, school_id, family_id, first_name, last_name, date_of_birth, created_by, updated_by, updated_at) VALUES
      (${STUDENT_A}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'Alice', 'A', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${STUDENT_B}::uuid, ${SCHOOL_B}::uuid, ${FAMILY_B}::uuid, 'Bob', 'B', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO invoices (
      id, school_id, family_id, invoice_number, period_start, period_end,
      subtotal_cents, gst_cents, total_cents,
      created_by, updated_by, updated_at
    ) VALUES
      (${INVOICE_A}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'INV-A1',
        '2026-05-01'::date, '2026-05-07'::date,
        2500, 250, 2750,
        ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${INVOICE_B}::uuid, ${SCHOOL_B}::uuid, ${FAMILY_B}::uuid, 'INV-B1',
        '2026-05-01'::date, '2026-05-07'::date,
        2500, 250, 2750,
        ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("invoice_lines: consistency trigger and CHECK constraints", () => {
  test("line with foreign-school invoice raises", async () => {
    await expect(
      admin.$executeRaw`
        INSERT INTO invoice_lines (
          school_id, invoice_id, student_id, description,
          amount_ex_gst_cents, gst_amount_cents, quantity, line_total_cents,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${INVOICE_B}::uuid, ${STUDENT_A}::uuid,
          'foreign-school invoice', 1000, 100, 1, 1100,
          ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/must match invoice\.school_id/);
  });

  test("line with foreign-school student raises", async () => {
    await expect(
      admin.$executeRaw`
        INSERT INTO invoice_lines (
          school_id, invoice_id, student_id, description,
          amount_ex_gst_cents, gst_amount_cents, quantity, line_total_cents,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${INVOICE_A}::uuid, ${STUDENT_B}::uuid,
          'foreign-school student', 1000, 100, 1, 1100,
          ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/must match student\.school_id/);
  });

  test("line_total_cents mismatch is rejected", async () => {
    await expect(
      admin.$executeRaw`
        INSERT INTO invoice_lines (
          school_id, invoice_id, student_id, description,
          amount_ex_gst_cents, gst_amount_cents, quantity, line_total_cents,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${INVOICE_A}::uuid, ${STUDENT_A}::uuid,
          'bad arithmetic', 1000, 100, 1, 9999,
          ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/invoice_lines_total_matches_check/);
  });

  test("quantity <= 0 is rejected", async () => {
    await expect(
      admin.$executeRaw`
        INSERT INTO invoice_lines (
          school_id, invoice_id, student_id, description,
          amount_ex_gst_cents, gst_amount_cents, quantity, line_total_cents,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${INVOICE_A}::uuid, ${STUDENT_A}::uuid,
          'zero quantity', 1000, 100, 0, 0,
          ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/invoice_lines_quantity_positive_check/);
  });

  test("a valid line writes successfully", async () => {
    await admin.$executeRaw`
      INSERT INTO invoice_lines (
        school_id, invoice_id, student_id, description,
        amount_ex_gst_cents, gst_amount_cents, quantity, line_total_cents,
        created_by, updated_by, updated_at
      ) VALUES (
        ${SCHOOL_A}::uuid, ${INVOICE_A}::uuid, ${STUDENT_A}::uuid,
        'weekly lesson', 2500, 250, 1, 2750,
        ${USER_A}::uuid, ${USER_A}::uuid, now()
      )
    `;
    const lines = await admin.invoiceLine.findMany({
      where: { invoiceId: INVOICE_A },
    });
    expect(lines.length).toBe(1);
    expect(lines[0]?.lineTotalCents).toBe(2750);
  });
});
