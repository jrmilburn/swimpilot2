import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as billingRepository from "../../src/repositories/billingRepository";
import {
  BillingFrequency,
  BillingProfileStatus,
  PaymentMethodType,
} from "../../src/domain/enums";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const FAMILY_A = "babababa-0000-0000-0000-00000000000a";
const FAMILY_B = "babababa-0000-0000-0000-00000000000b";
const FAMILY_C = "babababa-0000-0000-0000-00000000000c";

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
      (${FAMILY_B}::uuid, ${SCHOOL_A}::uuid, 'Family B', 'fam.b@example.com', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${FAMILY_C}::uuid, ${SCHOOL_A}::uuid, 'Family C', 'fam.c@example.com', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("billingRepository: profiles", () => {
  test("createProfile starts at pending_setup and round-trips by id and family", async () => {
    const profile = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        billingRepository.createProfile(tx, {
          familyId: FAMILY_A,
          billingFrequency: BillingFrequency.Weekly,
          billingAnchorDate: new Date("2026-05-04"),
          paymentMethodType: PaymentMethodType.Card,
        }),
    );

    expect(profile.schoolId).toBe(SCHOOL_A);
    expect(profile.familyId).toBe(FAMILY_A);
    expect(profile.status).toBe(BillingProfileStatus.PendingSetup);
    expect(profile.stripeCustomerId).toBeNull();
    expect(profile.stripePaymentMethodId).toBeNull();

    const byId = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => billingRepository.getProfileById(tx, profile.id),
    );
    expect(byId?.id).toBe(profile.id);

    const byFamily = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => billingRepository.getProfileByFamily(tx, FAMILY_A),
    );
    expect(byFamily?.id).toBe(profile.id);

    const row = await admin.billingProfile.findUnique({
      where: { id: profile.id },
    });
    expect(row?.createdBy).toBe(USER_A);
    expect(row?.updatedBy).toBe(USER_A);
  });

  test("updateProfile attaches stripe ids and promotes status", async () => {
    const profile = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        billingRepository.createProfile(tx, {
          familyId: FAMILY_B,
          billingFrequency: BillingFrequency.Fortnightly,
          billingAnchorDate: new Date("2026-05-04"),
          paymentMethodType: PaymentMethodType.Becs,
        }),
    );

    const updated = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        billingRepository.updateProfile(tx, profile.id, {
          stripeCustomerId: "cus_test_001",
          stripePaymentMethodId: "pm_test_001",
          status: BillingProfileStatus.Active,
        }),
    );

    expect(updated.status).toBe(BillingProfileStatus.Active);
    expect(updated.stripeCustomerId).toBe("cus_test_001");
    expect(updated.stripePaymentMethodId).toBe("pm_test_001");
  });

  test("listProfilesBySchool filters by status and paginates", async () => {
    // FAMILY_A and FAMILY_B already have profiles from prior tests. FAMILY_C
    // gets one here so we can test status filtering.
    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
      billingRepository.createProfile(tx, {
        familyId: FAMILY_C,
        billingFrequency: BillingFrequency.Weekly,
        billingAnchorDate: new Date("2026-05-04"),
        paymentMethodType: PaymentMethodType.Card,
      }),
    );

    const all = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => billingRepository.listProfilesBySchool(tx),
    );
    expect(all.items.length).toBe(3);

    const pending = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        billingRepository.listProfilesBySchool(tx, {
          status: BillingProfileStatus.PendingSetup,
        }),
    );
    // FAMILY_A and FAMILY_C are still pending; FAMILY_B was promoted to active.
    expect(pending.items.length).toBe(2);
    expect(
      pending.items.every(
        (p) => p.status === BillingProfileStatus.PendingSetup,
      ),
    ).toBe(true);
  });

  test("a second profile for the same family is rejected", async () => {
    // FAMILY_A already has a profile from the first test. The unique index
    // on family_id should reject a second one.
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        billingRepository.createProfile(tx, {
          familyId: FAMILY_A,
          billingFrequency: BillingFrequency.Weekly,
          billingAnchorDate: new Date("2026-06-01"),
          paymentMethodType: PaymentMethodType.Card,
        }),
      ),
    ).rejects.toThrow();
  });
});
