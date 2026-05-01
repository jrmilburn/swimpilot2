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

// Clerk reads these at module-init time. Mocked below; values are placeholders.
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

import { auth } from "@clerk/nextjs/server";
import { prisma } from "../../src/lib/db/client";
import { OnboardingStep, OnboardingStepStatus } from "../../src/domain/enums";
import { markProfileComplete } from "../../src/app/s/[schoolSlug]/onboarding/profile/_actions/markProfileComplete";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const RIVERSIDE_ID = "11111111-1111-1111-1111-111111111111";
const COASTAL_ID = "22222222-2222-2222-2222-222222222222";
const SOLO_USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SOLO_CLERK = "user_solo_test";

async function seed() {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations RESTART IDENTITY CASCADE`,
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

beforeAll(async () => {
  await seed();
});

beforeEach(async () => {
  vi.mocked(auth).mockReset();
  headerStore.current = new Headers();

  // Reset Riverside profile state and onboarding_progress to a known
  // pre-step starting point so each test has a fixed origin.
  await admin.$executeRaw`
    UPDATE schools
       SET legal_name = NULL, trading_name = NULL, abn = NULL,
           gst_registered = NULL, primary_contact_name = NULL,
           primary_contact_email = NULL, primary_contact_phone = NULL,
           logo_url = NULL, updated_at = now()
     WHERE id = ${RIVERSIDE_ID}::uuid
  `;
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

function mockAuth(clerkId: string | null) {
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);
}

function setSlug(slug: string) {
  headerStore.current = new Headers({ "x-school-slug": slug });
}

describe("markProfileComplete", () => {
  test("save: persists profile fields, marks step Completed, advances to Locations", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await markProfileComplete({
      skip: false,
      legalName: "Riverside Swim School Pty Ltd",
      tradingName: "Riverside Swim School",
      abn: "51824753556",
      gstRegistered: true,
      primaryContactName: "Maya Patel",
      primaryContactEmail: "owner@riverside.test",
      primaryContactPhone: "+61 2 9123 4567",
      logoUrl: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.currentStep).toBe(OnboardingStep.Locations);
    expect(result.data.stepStatuses[OnboardingStep.Profile]).toBe(
      OnboardingStepStatus.Completed,
    );
    expect(result.data.completedWizard).toBe(false);

    const row = await admin.school.findUnique({ where: { id: RIVERSIDE_ID } });
    expect(row?.legalName).toBe("Riverside Swim School Pty Ltd");
    expect(row?.abn).toBe("51824753556");
    expect(row?.gstRegistered).toBe(true);
  });

  test("save: ABN whitespace is stripped before persisting", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await markProfileComplete({
      skip: false,
      legalName: null,
      tradingName: null,
      abn: "51 824 753 556",
      gstRegistered: false,
      primaryContactName: null,
      primaryContactEmail: null,
      primaryContactPhone: null,
      logoUrl: null,
    });

    expect(result.ok).toBe(true);
    const row = await admin.school.findUnique({ where: { id: RIVERSIDE_ID } });
    expect(row?.abn).toBe("51824753556");
  });

  test("skip: leaves columns null, marks step Skipped, advances to Locations", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await markProfileComplete({ skip: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.currentStep).toBe(OnboardingStep.Locations);
    expect(result.data.stepStatuses[OnboardingStep.Profile]).toBe(
      OnboardingStepStatus.Skipped,
    );

    const row = await admin.school.findUnique({ where: { id: RIVERSIDE_ID } });
    expect(row?.legalName).toBeNull();
    expect(row?.abn).toBeNull();
    expect(row?.primaryContactEmail).toBeNull();
  });

  test("ABN of 10 digits is rejected with VALIDATION", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await markProfileComplete({
      skip: false,
      legalName: null,
      tradingName: null,
      abn: "1234567890",
      gstRegistered: false,
      primaryContactName: null,
      primaryContactEmail: null,
      primaryContactPhone: null,
      logoUrl: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toMatch(/ABN/i);
  });

  test("ABN of 12 digits is rejected with VALIDATION", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await markProfileComplete({
      skip: false,
      legalName: null,
      tradingName: null,
      abn: "123456789012",
      gstRegistered: false,
      primaryContactName: null,
      primaryContactEmail: null,
      primaryContactPhone: null,
      logoUrl: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("invalid email is rejected with VALIDATION", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await markProfileComplete({
      skip: false,
      legalName: null,
      tradingName: null,
      abn: null,
      gstRegistered: false,
      primaryContactName: null,
      primaryContactEmail: "not-an-email",
      primaryContactPhone: null,
      logoUrl: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toMatch(/email/i);
  });

  test("cross-tenant: SOLO_USER posting to coastal slug 404s", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("coastal"); // SOLO_USER has no membership in coastal

    await expect(markProfileComplete({ skip: true })).rejects.toMatchObject({
      digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404/),
    });
  });
});
