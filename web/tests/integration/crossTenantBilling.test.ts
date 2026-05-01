import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as billingRepository from "../../src/repositories/billingRepository";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const SCHOOL_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const FAMILY_B = "babababa-0000-0000-0000-00000000000b";
const STUDENT_B = "53000000-0000-0000-0000-00000000000b";
const PROFILE_B = "b0000000-0000-0000-0000-00000000000b";
const INVOICE_B = "1c000000-0000-0000-0000-00000000000b";
const CREDIT_B = "cd000000-0000-0000-0000-00000000000b";

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
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${USER_A}::uuid, 'owner', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO families (id, school_id, primary_contact_name, primary_contact_email, created_by, updated_by, updated_at) VALUES
      (${FAMILY_B}::uuid, ${SCHOOL_B}::uuid, 'Family B', 'fam.b@example.com', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO students (id, school_id, family_id, first_name, last_name, date_of_birth, created_by, updated_by, updated_at) VALUES
      (${STUDENT_B}::uuid, ${SCHOOL_B}::uuid, ${FAMILY_B}::uuid, 'Bob', 'B', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO billing_profiles (
      id, school_id, family_id, billing_frequency, billing_anchor_date,
      payment_method_type, created_by, updated_by, updated_at
    ) VALUES (
      ${PROFILE_B}::uuid, ${SCHOOL_B}::uuid, ${FAMILY_B}::uuid,
      'weekly'::billing_frequency, '2026-05-04'::date,
      'card'::payment_method_type,
      ${USER_A}::uuid, ${USER_A}::uuid, now()
    )
  `;
  await admin.$executeRaw`
    INSERT INTO invoices (
      id, school_id, family_id, invoice_number, period_start, period_end,
      subtotal_cents, gst_cents, total_cents,
      created_by, updated_by, updated_at
    ) VALUES (
      ${INVOICE_B}::uuid, ${SCHOOL_B}::uuid, ${FAMILY_B}::uuid, 'INV-B-001',
      '2026-04-01'::date, '2026-04-07'::date,
      2500, 250, 2750,
      ${USER_A}::uuid, ${USER_A}::uuid, now()
    )
  `;
  await admin.$executeRaw`
    INSERT INTO credits (
      id, school_id, family_id, amount_cents, source,
      created_by, updated_by, updated_at
    ) VALUES (
      ${CREDIT_B}::uuid, ${SCHOOL_B}::uuid, ${FAMILY_B}::uuid,
      1000, 'manual'::credit_source,
      ${USER_A}::uuid, ${USER_A}::uuid, now()
    )
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("billing tables: cross-tenant isolation under RLS", () => {
  test("scoped to A: getProfileByFamily for B's family returns null", async () => {
    const profile = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => billingRepository.getProfileByFamily(tx, FAMILY_B),
    );
    expect(profile).toBeNull();
  });

  test("scoped to A: getInvoiceById for B's invoice returns null", async () => {
    const invoice = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => billingRepository.getInvoiceById(tx, INVOICE_B),
    );
    expect(invoice).toBeNull();
  });

  test("scoped to A: listInvoicesByFamily(FAMILY_B) is empty", async () => {
    const page = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => billingRepository.listInvoicesByFamily(tx, FAMILY_B),
    );
    expect(page.items).toHaveLength(0);
  });

  test("scoped to A: getCreditById for B's credit returns null", async () => {
    const credit = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => billingRepository.getCreditById(tx, CREDIT_B),
    );
    expect(credit).toBeNull();
  });

  test("scoped to A: direct write of billing_profile with school_id=B is blocked", async () => {
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        tx.billingProfile.create({
          data: {
            schoolId: SCHOOL_B,
            familyId: FAMILY_B,
            billingFrequency: "weekly",
            billingAnchorDate: new Date("2026-05-04"),
            paymentMethodType: "card",
            createdBy: USER_A,
            updatedBy: USER_A,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  test("no tenant context: invoice and credit reads see nothing (fail closed)", async () => {
    const invoice = await billingRepository.getInvoiceById(prisma, INVOICE_B);
    expect(invoice).toBeNull();

    const credit = await billingRepository.getCreditById(prisma, CREDIT_B);
    expect(credit).toBeNull();
  });
});
