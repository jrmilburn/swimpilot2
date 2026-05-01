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

describe("invoices: consistency trigger and CHECK constraints", () => {
  test("invoice with family_id from another school raises", async () => {
    await expect(
      admin.$executeRaw`
        INSERT INTO invoices (
          school_id, family_id, invoice_number, period_start, period_end,
          subtotal_cents, gst_cents, total_cents,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${FAMILY_B}::uuid, 'INV-X1', '2026-05-01'::date, '2026-05-07'::date,
          2500, 250, 2750,
          ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/must match family\.school_id/);
  });

  test("period_end < period_start is rejected", async () => {
    await expect(
      admin.$executeRaw`
        INSERT INTO invoices (
          school_id, family_id, invoice_number, period_start, period_end,
          subtotal_cents, gst_cents, total_cents,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'INV-X2', '2026-05-07'::date, '2026-05-01'::date,
          2500, 250, 2750,
          ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/invoices_period_check/);
  });

  test("total_cents != subtotal + gst is rejected", async () => {
    await expect(
      admin.$executeRaw`
        INSERT INTO invoices (
          school_id, family_id, invoice_number, period_start, period_end,
          subtotal_cents, gst_cents, total_cents,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'INV-X3', '2026-05-01'::date, '2026-05-07'::date,
          2500, 250, 9999,
          ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/invoices_total_matches_subtotal_plus_gst_check/);
  });

  test("negative subtotal is rejected", async () => {
    await expect(
      admin.$executeRaw`
        INSERT INTO invoices (
          school_id, family_id, invoice_number, period_start, period_end,
          subtotal_cents, gst_cents, total_cents,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'INV-X4', '2026-05-01'::date, '2026-05-07'::date,
          -100, 250, 150,
          ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow(/invoices_subtotal_nonneg_check/);
  });

  test("a valid invoice writes successfully", async () => {
    await admin.$executeRaw`
      INSERT INTO invoices (
        school_id, family_id, invoice_number, period_start, period_end,
        subtotal_cents, gst_cents, total_cents,
        created_by, updated_by, updated_at
      ) VALUES (
        ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'INV-OK1', '2026-05-01'::date, '2026-05-07'::date,
        2500, 250, 2750,
        ${USER_A}::uuid, ${USER_A}::uuid, now()
      )
    `;
    const found = await admin.invoice.findFirst({
      where: { invoiceNumber: "INV-OK1" },
    });
    expect(found?.totalCents).toBe(2750);
  });

  test("(school_id, invoice_number) is unique", async () => {
    await admin.$executeRaw`
      INSERT INTO invoices (
        school_id, family_id, invoice_number, period_start, period_end,
        subtotal_cents, gst_cents, total_cents,
        created_by, updated_by, updated_at
      ) VALUES (
        ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'INV-DUP', '2026-05-01'::date, '2026-05-07'::date,
        1000, 100, 1100,
        ${USER_A}::uuid, ${USER_A}::uuid, now()
      )
    `;
    await expect(
      admin.$executeRaw`
        INSERT INTO invoices (
          school_id, family_id, invoice_number, period_start, period_end,
          subtotal_cents, gst_cents, total_cents,
          created_by, updated_by, updated_at
        ) VALUES (
          ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'INV-DUP', '2026-06-01'::date, '2026-06-07'::date,
          1000, 100, 1100,
          ${USER_A}::uuid, ${USER_A}::uuid, now()
        )
      `,
    ).rejects.toThrow();
  });
});
