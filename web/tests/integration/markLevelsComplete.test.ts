import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { PrismaClient } from "@prisma/client";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??=
  "pk_test_dGVzdC10ZXN0LXRlc3QudGVzdC50ZXN0LWlu";
process.env.CLERK_SECRET_KEY ??= "sk_test_dGVzdC10ZXN0LXRlc3QtdGVzdA";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
}));

const headerStore: { current: Headers } = { current: new Headers() };
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => headerStore.current),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { auth } from "@clerk/nextjs/server";
import { prisma } from "../../src/lib/db/client";
import { OnboardingStep, OnboardingStepStatus } from "../../src/domain/enums";
import { markLevelsComplete } from "../../src/app/s/[schoolSlug]/onboarding/levels/_actions/markLevelsComplete";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const RIVERSIDE_ID = "11111111-1111-1111-1111-111111111111";
const COASTAL_ID = "22222222-2222-2222-2222-222222222222";
const SOLO_USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SOLO_CLERK = "user_solo_test";

async function seed() {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, class_levels RESTART IDENTITY CASCADE`,
  );
  await admin.$executeRaw`
    INSERT INTO users (id, clerk_id, email, name, updated_at) VALUES
      (${SOLO_USER}::uuid, ${SOLO_CLERK}, 'solo@example.com', 'Solo User', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${RIVERSIDE_ID}::uuid, 'riverside', 'Riverside Swim School', 'Australia/Sydney', 'AUD', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now()),
      (${COASTAL_ID}::uuid,   'coastal',   'Coastal Swim School',   'Australia/Sydney', 'AUD', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${RIVERSIDE_ID}::uuid, ${SOLO_USER}::uuid, 'owner', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
}

async function resetProgress(schoolId: string) {
  await admin.$executeRaw`
    UPDATE onboarding_progress
       SET current_step = 'levels',
           step_statuses = jsonb_build_object(
             'profile','completed','locations','completed','levels','not_started',
             'skills','not_started','classes','not_started','teachers','not_started',
             'billing','not_started','channels','not_started','import','not_started'
           ),
           completed_at = NULL,
           updated_at = now()
     WHERE school_id = ${schoolId}::uuid
  `;
}

beforeAll(async () => {
  await seed();
});

beforeEach(async () => {
  vi.mocked(auth).mockReset();
  headerStore.current = new Headers();
  await admin.$executeRawUnsafe(`DELETE FROM class_levels`);
  await resetProgress(RIVERSIDE_ID);
  await resetProgress(COASTAL_ID);
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

function mockAuth(clerkId: string | null) {
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);
}
function setSlug(slug: string) {
  headerStore.current = new Headers({ "x-school-slug": slug });
}

describe("markLevelsComplete", () => {
  test("save with one level advances current_step to Skills with status Completed", async () => {
    await admin.classLevel.create({
      data: {
        schoolId: RIVERSIDE_ID,
        name: "Beginner",
        ratio: 6,
        orderIndex: 0,
        createdBy: SOLO_USER,
        updatedBy: SOLO_USER,
      },
    });

    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await markLevelsComplete({ skip: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.currentStep).toBe(OnboardingStep.Skills);
    expect(result.data.stepStatuses[OnboardingStep.Levels]).toBe(
      OnboardingStepStatus.Completed,
    );
    expect(result.data.completedWizard).toBe(false);
  });

  test("save with zero levels rejects with VALIDATION + fieldErrors._form", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await markLevelsComplete({ skip: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.fieldErrors?._form).toMatch(/at least one level/i);
  });

  test("skip with zero levels advances with status Skipped", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await markLevelsComplete({ skip: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.currentStep).toBe(OnboardingStep.Skills);
    expect(result.data.stepStatuses[OnboardingStep.Levels]).toBe(
      OnboardingStepStatus.Skipped,
    );
  });

  test("cross-tenant: SOLO_USER posting to coastal slug 404s before any read", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("coastal");

    await expect(markLevelsComplete({ skip: false })).rejects.toMatchObject({
      digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404/),
    });
  });
});
