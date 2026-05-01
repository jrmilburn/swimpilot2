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
const INV_A = "1c000000-0000-0000-0000-00000000000a";

const CRED_AVAIL_NOEXP = "cd000000-0000-0000-0000-00000000000a";
const CRED_AVAIL_FUTURE = "cd000000-0000-0000-0000-00000000000b";
const CRED_AVAIL_EXPIRED = "cd000000-0000-0000-0000-00000000000c";
const CRED_APPLIED = "cd000000-0000-0000-0000-00000000000d";
const CRED_VOID = "cd000000-0000-0000-0000-00000000000e";
const CRED_OTHER_FAMILY = "cd000000-0000-0000-0000-00000000000f";

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
      (${STUDENT_A}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'Alice', 'A', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  // An invoice for Family A so we can attach an applied credit to it.
  await admin.$executeRaw`
    INSERT INTO invoices (
      id, school_id, family_id, invoice_number, period_start, period_end,
      subtotal_cents, gst_cents, total_cents,
      created_by, updated_by, updated_at
    ) VALUES
      (${INV_A}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, 'INV-A-001',
        '2026-04-01'::date, '2026-04-07'::date,
        2500, 250, 2750,
        ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  // Six credits in mixed states. Only the two 'available' + non-expired
  // ones for Family A should appear in listAvailableCreditsForFamily.
  await admin.$executeRaw`
    INSERT INTO credits (
      id, school_id, family_id, student_id, amount_cents, source,
      expires_at, status, applied_to_invoice_id, applied_at,
      created_by, updated_by, updated_at, created_at
    ) VALUES
      (${CRED_AVAIL_NOEXP}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, NULL,
        1000, 'school_cancellation'::credit_source,
        NULL, 'available'::credit_status, NULL, NULL,
        ${USER_A}::uuid, ${USER_A}::uuid, now(), '2026-01-01'::timestamptz),
      (${CRED_AVAIL_FUTURE}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, ${STUDENT_A}::uuid,
        2000, 'notified_absence'::credit_source,
        '2027-01-01'::timestamptz, 'available'::credit_status, NULL, NULL,
        ${USER_A}::uuid, ${USER_A}::uuid, now(), '2026-02-01'::timestamptz),
      (${CRED_AVAIL_EXPIRED}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, NULL,
        1500, 'manual'::credit_source,
        '2026-01-01'::timestamptz, 'available'::credit_status, NULL, NULL,
        ${USER_A}::uuid, ${USER_A}::uuid, now(), '2025-12-01'::timestamptz),
      (${CRED_APPLIED}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, NULL,
        500, 'manual'::credit_source,
        NULL, 'applied'::credit_status, ${INV_A}::uuid, '2026-04-10'::timestamptz,
        ${USER_A}::uuid, ${USER_A}::uuid, now(), '2026-03-01'::timestamptz),
      (${CRED_VOID}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_A}::uuid, NULL,
        750, 'refund'::credit_source,
        NULL, 'void'::credit_status, NULL, NULL,
        ${USER_A}::uuid, ${USER_A}::uuid, now(), '2026-03-15'::timestamptz),
      (${CRED_OTHER_FAMILY}::uuid, ${SCHOOL_A}::uuid, ${FAMILY_B}::uuid, NULL,
        9000, 'school_cancellation'::credit_source,
        NULL, 'available'::credit_status, NULL, NULL,
        ${USER_A}::uuid, ${USER_A}::uuid, now(), '2026-04-01'::timestamptz)
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("billingRepository: credit reads", () => {
  test("listAvailableCreditsForFamily filters out expired, applied, void, and other-family credits", async () => {
    const credits = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        billingRepository.listAvailableCreditsForFamily(
          tx,
          FAMILY_A,
          new Date("2026-04-01"),
        ),
    );
    expect(credits.length).toBe(2);
    const ids = credits.map((c) => c.id).sort();
    expect(ids).toEqual([CRED_AVAIL_NOEXP, CRED_AVAIL_FUTURE].sort());
    expect(credits.every((c) => c.familyId === FAMILY_A)).toBe(true);
    expect(credits.every((c) => c.status === "available")).toBe(true);
  });

  test("listCreditsByFamily returns every credit for the family in any state", async () => {
    const page = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => billingRepository.listCreditsByFamily(tx, FAMILY_A),
    );
    expect(page.items.length).toBe(5);
    expect(page.items.every((c) => c.familyId === FAMILY_A)).toBe(true);
  });

  test("getCreditById round-trips one credit", async () => {
    const credit = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => billingRepository.getCreditById(tx, CRED_APPLIED),
    );
    expect(credit?.status).toBe("applied");
    expect(credit?.appliedToInvoiceId).toBe(INV_A);
    expect(credit?.appliedAt).not.toBeNull();
  });
});
