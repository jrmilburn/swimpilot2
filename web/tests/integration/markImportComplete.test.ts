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
import { markImportComplete } from "../../src/app/s/[schoolSlug]/onboarding/import/_actions/markImportComplete";

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
      (${RIVERSIDE_ID}::uuid, 'riverside', 'Riverside Swim School', 'Australia/Sydney', 'AUD', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${RIVERSIDE_ID}::uuid, ${SOLO_USER}::uuid, 'owner', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
}

async function resetProgressToImport(schoolId: string) {
  await admin.$executeRaw`
    UPDATE onboarding_progress
       SET current_step = 'import',
           step_statuses = jsonb_build_object(
             'profile','completed','locations','completed','levels','completed',
             'skills','completed','classes','completed','teachers','completed',
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
  await admin.$executeRawUnsafe(
    `TRUNCATE import_batches RESTART IDENTITY CASCADE`,
  );
  await resetProgressToImport(RIVERSIDE_ID);
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

async function seedOneCommittedBatch(schoolId: string) {
  await admin.$executeRaw`
    INSERT INTO import_batches (
      id, school_id, mapping, row_count, family_count, student_count,
      enrolment_count, committed_at, created_by, updated_by, updated_at
    ) VALUES (
      gen_random_uuid(), ${schoolId}::uuid, '{}'::jsonb, 0, 0, 0, 0,
      now(), ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now()
    )
  `;
}

describe("markImportComplete", () => {
  test("save with no committed batch fails validation", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await markImportComplete({ skip: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toMatch(/Import at least one CSV/i);

    const row = await admin.onboardingProgress.findUnique({
      where: { schoolId: RIVERSIDE_ID },
    });
    // Wizard not completed.
    expect(row?.completedAt).toBeNull();
  });

  test("save with committed batch flips completed_at, sets current_step=done", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");
    await seedOneCommittedBatch(RIVERSIDE_ID);

    const result = await markImportComplete({ skip: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.currentStep).toBe(OnboardingStep.Done);
    expect(result.data.completedWizard).toBe(true);
    expect(result.data.completedAt).toBeInstanceOf(Date);

    const row = await admin.onboardingProgress.findUnique({
      where: { schoolId: RIVERSIDE_ID },
    });
    expect(row?.completedAt).not.toBeNull();
    expect(row?.currentStep).toBe(OnboardingStep.Done);
    const statuses = row?.stepStatuses as Record<string, string>;
    expect(statuses.import).toBe(OnboardingStepStatus.Completed);
  });

  test("skip flips completed_at and stamps Import as Skipped", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await markImportComplete({ skip: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.currentStep).toBe(OnboardingStep.Done);
    expect(result.data.completedWizard).toBe(true);

    const row = await admin.onboardingProgress.findUnique({
      where: { schoolId: RIVERSIDE_ID },
    });
    const statuses = row?.stepStatuses as Record<string, string>;
    expect(statuses.import).toBe(OnboardingStepStatus.Skipped);
    expect(row?.completedAt).not.toBeNull();
  });

  test("calling twice is idempotent — completed_at stays set", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");
    await seedOneCommittedBatch(RIVERSIDE_ID);

    const first = await markImportComplete({ skip: false });
    expect(first.ok).toBe(true);
    const second = await markImportComplete({ skip: false });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.completedWizard).toBe(true);
    expect(second.data.currentStep).toBe(OnboardingStep.Done);
  });
});
