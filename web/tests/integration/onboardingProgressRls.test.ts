import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import { OnboardingStep, OnboardingStepStatus } from "../../src/domain/enums";
import * as onboardingProgressRepository from "../../src/repositories/onboardingProgressRepository";

// onboarding_progress is one of the cross-tenant-sensitive tables in
// Sprint 4 — the row's PK is school_id, and a misconfigured RLS policy
// would let School A read or mutate School B's wizard state. These
// tests pin tenant isolation: scoped reads filter to the open tenant,
// and cross-tenant updates fail with a WITH CHECK violation.

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const SCHOOL_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations RESTART IDENTITY CASCADE`,
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
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("onboarding_progress RLS isolation", () => {
  test("scoped to A: getBySchool(A) returns A's row", async () => {
    const row = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => onboardingProgressRepository.getBySchool(tx, SCHOOL_A),
    );
    expect(row).not.toBeNull();
    expect(row!.schoolId).toBe(SCHOOL_A);
  });

  test("scoped to A: getBySchool(B) returns null (RLS filters)", async () => {
    const row = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => onboardingProgressRepository.getBySchool(tx, SCHOOL_B),
    );
    expect(row).toBeNull();
  });

  test("scoped to A: markStepStatus targeting B throws (the row appears not to exist)", async () => {
    // RLS hides B from A's reads, so the repository's own existence check
    // sees no row and throws NotFoundError. Effect from the caller's
    // perspective: the cross-tenant write doesn't happen.
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        onboardingProgressRepository.markStepStatus(tx, {
          schoolId: SCHOOL_B,
          step: OnboardingStep.Profile,
          status: OnboardingStepStatus.Completed,
        }),
      ),
    ).rejects.toThrow();

    // Confirm B's row is unchanged via the admin connection.
    const rows = await admin.$queryRaw<
      Array<{ current_step: string; step_statuses: Record<string, string> }>
    >`
      SELECT current_step, step_statuses FROM onboarding_progress
      WHERE school_id = ${SCHOOL_B}::uuid
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.step_statuses.profile).toBe("not_started");
  });

  test("no tenant context: unscoped getBySchool returns null", async () => {
    const row = await onboardingProgressRepository.getBySchool(
      prisma,
      SCHOOL_A,
    );
    expect(row).toBeNull();
  });
});
