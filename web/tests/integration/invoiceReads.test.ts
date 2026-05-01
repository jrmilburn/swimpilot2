import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as billingRepository from "../../src/repositories/billingRepository";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const FAMILY_A = "babababa-0000-0000-0000-00000000000a";
const FAMILY_B = "babababa-0000-0000-0000-00000000000b";
const STUDENT_A = "53000000-0000-0000-0000-00000000000a";
const STUDENT_B = "53000000-0000-0000-0000-00000000000b";

const INV_A_OLD = "1c000000-0000-0000-0000-00000000000a";
const INV_A_NEW = "1c000000-0000-0000-0000-00000000001a";
const INV_A_OVERDUE = "1c000000-0000-0000-0000-00000000002a";
const INV_A_PAID = "1c000000-0000-0000-0000-00000000003a";
const INV_B_ISSUED = "1c000000-0000-0000-0000-00000000000b";

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
      (${SCHOOL_A}::uuid, 'school-a', 'School A', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${USER_A}::uuid, 'owner', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO families (id, school_id, primary_contact_name, primary_contact_email, created_by, updated_by, updated_at) VALUES
      (${FAMILY_A}::uuid, ${SCHOOL_A}::uuid, 'Family A', 'fam.a@example.com', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${FAMILY_B}::uuid, ${SCHOOL_A}::uuid, 'Family B', 'fam.b@example.com', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO students (id, school_id, family_id, first_name, last_name, date_of_birth, created_by, updated_by, updated_at) VALUES
      (${STUDENT_A}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'Alice', 'A', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${STUDENT_B}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_B}::uuid, 'Bob',   'B', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  // Family A invoices: an old issued, a newer issued, an overdue (issued+past
  // due_at), and a paid one. Family B has one issued invoice. Pre-seeded via
  // admin client because invoice creation lives in Sprint 8 — Chunk 5 has no
  // repository surface for it.
  await admin.$executeRaw`
    INSERT INTO invoices (
      id, school_id, family_id, invoice_number, period_start, period_end,
      subtotal_cents, gst_cents, total_cents, status, issued_at, due_at, paid_at,
      created_by, updated_by, updated_at
    ) VALUES
      (${INV_A_OLD}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'INV-A-001',
        '2026-03-01'::date, '2026-03-07'::date,
        2500, 250, 2750, 'issued'::invoice_status,
        '2026-03-08'::timestamptz, '2026-03-15'::timestamptz, NULL,
        ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${INV_A_NEW}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'INV-A-002',
        '2026-04-01'::date, '2026-04-07'::date,
        2500, 250, 2750, 'issued'::invoice_status,
        '2026-04-08'::timestamptz, '2026-05-15'::timestamptz, NULL,
        ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${INV_A_OVERDUE}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'INV-A-003',
        '2026-02-01'::date, '2026-02-07'::date,
        3000, 300, 3300, 'issued'::invoice_status,
        '2026-02-08'::timestamptz, '2026-02-15'::timestamptz, NULL,
        ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${INV_A_PAID}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'INV-A-004',
        '2026-01-01'::date, '2026-01-07'::date,
        2000, 200, 2200, 'paid'::invoice_status,
        '2026-01-08'::timestamptz, '2026-01-15'::timestamptz, '2026-01-14'::timestamptz,
        ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${INV_B_ISSUED}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_B}::uuid, 'INV-B-001',
        '2026-04-01'::date, '2026-04-07'::date,
        2500, 250, 2750, 'issued'::invoice_status,
        '2026-04-08'::timestamptz, '2026-05-15'::timestamptz, NULL,
        ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO invoice_lines (
      school_id, invoice_id, student_id, description,
      amount_ex_gst_cents, gst_amount_cents, quantity, line_total_cents,
      created_by, updated_by, updated_at
    ) VALUES
      (${SCHOOL_A}::uuid, ${INV_A_NEW}::uuid, ${STUDENT_A}::uuid,
        'Weekly lesson', 2500, 250, 1, 2750,
        ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("billingRepository: invoice reads", () => {
  test("getInvoiceWithLines returns the invoice plus its lines", async () => {
    const result = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => billingRepository.getInvoiceWithLines(tx, INV_A_NEW),
    );
    expect(result).not.toBeNull();
    expect(result?.invoice.id).toBe(INV_A_NEW);
    expect(result?.invoice.totalCents).toBe(2750);
    expect(result?.lines.length).toBe(1);
    expect(result?.lines[0]?.studentId).toBe(STUDENT_A);
  });

  test("getInvoiceWithLines returns null for an unknown id", async () => {
    const result = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        billingRepository.getInvoiceWithLines(
          tx,
          "00000000-0000-0000-0000-000000000000",
        ),
    );
    expect(result).toBeNull();
  });

  test("listInvoicesByFamily returns this family's invoices, newest period first", async () => {
    const page = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => billingRepository.listInvoicesByFamily(tx, FAMILY_A),
    );
    expect(page.items.length).toBe(4);
    // periodStart desc: NEW (2026-04) > OLD (2026-03) > OVERDUE (2026-02) > PAID (2026-01)
    expect(page.items.map((i) => i.id)).toEqual([
      INV_A_NEW,
      INV_A_OLD,
      INV_A_OVERDUE,
      INV_A_PAID,
    ]);
    // None of Family B's invoices leak in.
    expect(page.items.every((i) => i.familyId === FAMILY_A)).toBe(true);
  });

  test("listInvoicesBySchool returns every invoice in the school", async () => {
    const page = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => billingRepository.listInvoicesBySchool(tx),
    );
    expect(page.items.length).toBe(5);
  });

  test("listInvoicesBySchool filters by status", async () => {
    const page = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        billingRepository.listInvoicesBySchool(tx, { status: "paid" as never }),
    );
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.id).toBe(INV_A_PAID);
  });

  test("listOverdue returns issued invoices whose due_at is before asOf", async () => {
    // asOf = 2026-04-01; INV_A_OLD (due 2026-03-15) and INV_A_OVERDUE
    // (due 2026-02-15) are both still 'issued' and past due. The newer
    // issued ones (due 2026-05-15) are not yet overdue. The paid one is
    // excluded because status != 'issued'.
    const overdue = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => billingRepository.listOverdue(tx, new Date("2026-04-01")),
    );
    expect(overdue.length).toBe(2);
    // Sorted by due_at ascending: OVERDUE (2026-02-15) before OLD (2026-03-15).
    expect(overdue.map((i) => i.id)).toEqual([INV_A_OVERDUE, INV_A_OLD]);
  });
});
