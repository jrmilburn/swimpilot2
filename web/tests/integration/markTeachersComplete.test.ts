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
import { markTeachersComplete } from "../../src/app/s/[schoolSlug]/onboarding/teachers/_actions/markTeachersComplete";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const RIVERSIDE_ID = "11111111-1111-1111-1111-111111111111";
const SOLO_USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SOLO_CLERK = "user_solo_test";

async function seed() {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships RESTART IDENTITY CASCADE`,
  );
  await admin.$executeRaw`
    INSERT INTO users (id, clerk_id, email, name, updated_at) VALUES
      (${SOLO_USER}::uuid, ${SOLO_CLERK}, 'solo@example.com', 'Solo User', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${RIVERSIDE_ID}::uuid, 'riverside', 'Riverside', 'Australia/Sydney', 'AUD', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${RIVERSIDE_ID}::uuid, ${SOLO_USER}::uuid, 'owner', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
}

async function resetProgressToTeachers(schoolId: string) {
  await admin.$executeRaw`
    UPDATE onboarding_progress
       SET current_step = 'teachers',
           step_statuses = jsonb_build_object(
             'profile','completed','locations','completed','levels','completed',
             'skills','completed','classes','completed','teachers','not_started',
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
  await resetProgressToTeachers(RIVERSIDE_ID);
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

describe("markTeachersComplete", () => {
  test("save with zero teachers and zero invitations advances to Import (no count gate)", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await markTeachersComplete({ skip: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.currentStep).toBe(OnboardingStep.Import);
    expect(result.data.stepStatuses[OnboardingStep.Teachers]).toBe(
      OnboardingStepStatus.Completed,
    );
    expect(result.data.completedWizard).toBe(false);
    expect(result.data.completedAt).toBeNull();
  });

  test("skip advances to Import with Skipped status, completed_at remains null", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await markTeachersComplete({ skip: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.currentStep).toBe(OnboardingStep.Import);
    expect(result.data.stepStatuses[OnboardingStep.Teachers]).toBe(
      OnboardingStepStatus.Skipped,
    );
    expect(result.data.completedAt).toBeNull();
  });
});
