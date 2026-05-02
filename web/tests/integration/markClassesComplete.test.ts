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
import { markClassesComplete } from "../../src/app/s/[schoolSlug]/onboarding/classes/_actions/markClassesComplete";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const RIVERSIDE_ID = "11111111-1111-1111-1111-111111111111";
const SOLO_USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SOLO_CLERK = "user_solo_test";
const LOCATION_ID = "aaaaaaa0-0000-0000-0000-00000000000a";
const LEVEL_ID = "eeeeeee0-0000-0000-0000-00000000000a";

async function seed() {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations, class_levels, classes RESTART IDENTITY CASCADE`,
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
  await admin.$executeRaw`
    INSERT INTO locations (id, school_id, name, created_by, updated_by, updated_at) VALUES
      (${LOCATION_ID}::uuid, ${RIVERSIDE_ID}::uuid, 'Pool 1', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO class_levels (id, school_id, name, ratio, order_index, created_by, updated_by, updated_at) VALUES
      (${LEVEL_ID}::uuid, ${RIVERSIDE_ID}::uuid, 'Infants', 4, 0, ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
}

async function resetProgressToClasses(schoolId: string) {
  await admin.$executeRaw`
    UPDATE onboarding_progress
       SET current_step = 'classes',
           step_statuses = jsonb_build_object(
             'profile','completed','locations','completed','levels','completed',
             'skills','completed','classes','not_started','teachers','not_started',
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
  await admin.$executeRawUnsafe(`DELETE FROM classes`);
  await resetProgressToClasses(RIVERSIDE_ID);
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

async function insertClass() {
  await admin.$executeRaw`
    INSERT INTO classes (
      id, school_id, location_id, level_id,
      day_of_week, start_time, duration_minutes, capacity,
      created_by, updated_by, updated_at
    ) VALUES (
      gen_random_uuid(), ${RIVERSIDE_ID}::uuid, ${LOCATION_ID}::uuid, ${LEVEL_ID}::uuid,
      'monday', '16:00:00', 30, 4,
      ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now()
    )
  `;
}

describe("markClassesComplete", () => {
  test("save with one class advances current_step to Teachers, status Completed", async () => {
    await insertClass();
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await markClassesComplete({ skip: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.currentStep).toBe(OnboardingStep.Teachers);
    expect(result.data.stepStatuses[OnboardingStep.Classes]).toBe(
      OnboardingStepStatus.Completed,
    );
    expect(result.data.completedWizard).toBe(false);
  });

  test("save with zero classes rejects with VALIDATION + fieldErrors._form", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await markClassesComplete({ skip: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.fieldErrors?._form).toMatch(/at least one class/i);
  });

  test("skip with zero classes is allowed and advances with Skipped", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await markClassesComplete({ skip: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.currentStep).toBe(OnboardingStep.Teachers);
    expect(result.data.stepStatuses[OnboardingStep.Classes]).toBe(
      OnboardingStepStatus.Skipped,
    );
  });
});
