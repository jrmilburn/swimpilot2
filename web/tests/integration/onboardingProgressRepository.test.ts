import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import { OnboardingStep, OnboardingStepStatus } from "../../src/domain/enums";
import * as onboardingProgressRepository from "../../src/repositories/onboardingProgressRepository";
import { NotFoundError } from "../../src/lib/errors";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const RIVERSIDE_ID = "11111111-1111-1111-1111-111111111111";
const SEED_USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations RESTART IDENTITY CASCADE`,
  );
  await admin.$executeRaw`
    INSERT INTO users (id, email, name, updated_at) VALUES
      (${SEED_USER}::uuid, 'seed@example.com', 'Seed User', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${RIVERSIDE_ID}::uuid, 'riverside', 'Riverside Swim School', 'Australia/Sydney', 'AUD', ${SEED_USER}::uuid, ${SEED_USER}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${RIVERSIDE_ID}::uuid, ${SEED_USER}::uuid, 'owner', ${SEED_USER}::uuid, ${SEED_USER}::uuid, now())
  `;
  // Trigger fired on the school INSERT; reset the row to a known
  // pre-progress state so we can exercise getBySchool / markStepStatus /
  // complete from a fixed starting point.
  await admin.$executeRaw`
    UPDATE onboarding_progress
       SET current_step = 'profile',
           step_statuses = jsonb_build_object(
             'profile','not_started','locations','not_started','levels','not_started',
             'skills','not_started','classes','not_started','teachers','not_started',
             'billing','not_started','channels','not_started','import','not_started'
           ),
           completed_at = NULL,
           updated_at = now()
     WHERE school_id = ${RIVERSIDE_ID}::uuid
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("onboardingProgressRepository", () => {
  test("getBySchool returns the row mapped to the domain shape", async () => {
    const row = await withTenant(
      { schoolId: RIVERSIDE_ID, userId: SEED_USER },
      (tx) => onboardingProgressRepository.getBySchool(tx, RIVERSIDE_ID),
    );
    expect(row).not.toBeNull();
    expect(row!.schoolId).toBe(RIVERSIDE_ID);
    expect(row!.currentStep).toBe(OnboardingStep.Profile);
    expect(row!.completedAt).toBeNull();
    expect(row!.stepStatuses[OnboardingStep.Profile]).toBe(
      OnboardingStepStatus.NotStarted,
    );
  });

  test("markStepStatus flips one step and advances current_step when nextStep is supplied", async () => {
    const row = await withTenant(
      { schoolId: RIVERSIDE_ID, userId: SEED_USER },
      (tx) =>
        onboardingProgressRepository.markStepStatus(tx, {
          schoolId: RIVERSIDE_ID,
          step: OnboardingStep.Profile,
          status: OnboardingStepStatus.Completed,
          nextStep: OnboardingStep.Locations,
        }),
    );
    expect(row.currentStep).toBe(OnboardingStep.Locations);
    expect(row.stepStatuses[OnboardingStep.Profile]).toBe(
      OnboardingStepStatus.Completed,
    );
    // Other steps untouched.
    expect(row.stepStatuses[OnboardingStep.Locations]).toBe(
      OnboardingStepStatus.NotStarted,
    );
  });

  test("markStepStatus without nextStep keeps current_step where it was", async () => {
    const before = await withTenant(
      { schoolId: RIVERSIDE_ID, userId: SEED_USER },
      (tx) => onboardingProgressRepository.getBySchool(tx, RIVERSIDE_ID),
    );
    const row = await withTenant(
      { schoolId: RIVERSIDE_ID, userId: SEED_USER },
      (tx) =>
        onboardingProgressRepository.markStepStatus(tx, {
          schoolId: RIVERSIDE_ID,
          step: OnboardingStep.Locations,
          status: OnboardingStepStatus.InProgress,
        }),
    );
    expect(row.currentStep).toBe(before!.currentStep);
    expect(row.stepStatuses[OnboardingStep.Locations]).toBe(
      OnboardingStepStatus.InProgress,
    );
  });

  test("complete sets completed_at and parks current_step on done", async () => {
    const row = await withTenant(
      { schoolId: RIVERSIDE_ID, userId: SEED_USER },
      (tx) => onboardingProgressRepository.complete(tx, RIVERSIDE_ID),
    );
    expect(row.currentStep).toBe(OnboardingStep.Done);
    expect(row.completedAt).toBeInstanceOf(Date);
  });

  test("markStepStatus throws NotFoundError when no row exists for the school", async () => {
    // The PK is school_id and an onboarding_progress row only exists if
    // there's a matching school. A bogus uuid gives us "no row" without
    // breaking RLS. The tenant context still has to be the real school
    // for the SQL to even run; the repository's own SELECT returns null
    // and triggers the NotFoundError throw.
    const bogus = "99999999-9999-9999-9999-999999999999";
    await expect(
      withTenant({ schoolId: RIVERSIDE_ID, userId: SEED_USER }, (tx) =>
        onboardingProgressRepository.markStepStatus(tx, {
          schoolId: bogus,
          step: OnboardingStep.Profile,
          status: OnboardingStepStatus.Completed,
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
