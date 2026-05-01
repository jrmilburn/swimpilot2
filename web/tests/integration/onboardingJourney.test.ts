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

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { auth } from "@clerk/nextjs/server";
import { prisma } from "../../src/lib/db/client";
import { OnboardingStep, OnboardingStepStatus } from "../../src/domain/enums";
import { markProfileComplete } from "../../src/app/s/[schoolSlug]/onboarding/profile/_actions/markProfileComplete";
import { addLocation } from "../../src/app/s/[schoolSlug]/onboarding/locations/_actions/addLocation";
import { markLocationsComplete } from "../../src/app/s/[schoolSlug]/onboarding/locations/_actions/markLocationsComplete";
import { applyAssaDefaults } from "../../src/app/s/[schoolSlug]/onboarding/levels/_actions/applyAssaDefaults";
import { markLevelsComplete } from "../../src/app/s/[schoolSlug]/onboarding/levels/_actions/markLevelsComplete";
import { applyAssaSkillsForLevel } from "../../src/app/s/[schoolSlug]/onboarding/skills/_actions/applyAssaSkillsForLevel";
import { markSkillsComplete } from "../../src/app/s/[schoolSlug]/onboarding/skills/_actions/markSkillsComplete";
import { skipRemainingOnboarding } from "../../src/app/s/[schoolSlug]/onboarding/classes/_actions/skipRemainingOnboarding";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const RIVERSIDE_ID = "11111111-1111-1111-1111-111111111111";
const SOLO_USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SOLO_CLERK = "user_solo_test";

async function seed() {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations, class_levels, skills RESTART IDENTITY CASCADE`,
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

async function resetProgress() {
  await admin.$executeRawUnsafe(`DELETE FROM locations`);
  await admin.$executeRawUnsafe(`DELETE FROM skills`);
  await admin.$executeRawUnsafe(`DELETE FROM class_levels`);
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
}

beforeAll(async () => {
  await seed();
});

beforeEach(async () => {
  vi.mocked(auth).mockReset();
  headerStore.current = new Headers();
  await resetProgress();
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

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!result.ok) {
    throw new Error(`expected ok=true, got error ${result.error.code}: ${result.error.message}`);
  }
  return result.data;
}

// End-to-end journey through the four-step Sprint 4 wizard plus the
// Sprint 5 stub. The per-step tests cover field-level validation; this
// test exists to catch regressions in the seams *between* chunks —
// completing Profile lands you in Locations, the Skills→Classes
// short-circuit reversal stayed reversed, the stub's
// `skipRemainingOnboarding` flips the wizard to `done`.
//
// Two journeys: one saving real data at every step, one skipping every
// skip-able step. Locations cannot be skipped (Chunk 3 contract) so its
// happy path is the same in both.
//
// Vitest, not Playwright. Discussed in the chunk-6 handoff: a browser
// test would duplicate the per-chunk form coverage and pull in a new
// runner / dependency for thin marginal value while the wizard is
// mostly server-rendered.
describe("onboardingJourney", () => {
  test("save path: walks all four steps + classes stub to a completed wizard", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    // 1. Profile
    {
      const data = unwrap(
        await markProfileComplete({
          skip: false,
          legalName: "Riverside Swim School Pty Ltd",
          tradingName: "Riverside Swim School",
          abn: "51824753556",
          gstRegistered: true,
          primaryContactName: "Maya Patel",
          primaryContactEmail: "owner@riverside.test",
          primaryContactPhone: "+61 2 9123 4567",
          logoUrl: null,
        }),
      );
      expect(data.stepStatuses[OnboardingStep.Profile]).toBe(
        OnboardingStepStatus.Completed,
      );
      expect(data.currentStep).toBe(OnboardingStep.Locations);
      expect(data.completedWizard).toBe(false);
    }

    // 2. Locations — add one, then mark complete
    unwrap(
      await addLocation({
        name: "Main Pool",
        addressLine: "1 Pool Lane",
        suburb: "Sydney",
        state: "NSW",
        postcode: "2000",
        timezone: null,
        notes: null,
      }),
    );
    {
      const data = unwrap(await markLocationsComplete());
      expect(data.stepStatuses[OnboardingStep.Locations]).toBe(
        OnboardingStepStatus.Completed,
      );
      expect(data.currentStep).toBe(OnboardingStep.Levels);
      expect(data.completedWizard).toBe(false);
    }

    // 3. Levels — apply ASSA defaults, then mark complete
    {
      const applied = unwrap(await applyAssaDefaults());
      expect(applied.applied).toBe(4);
    }
    const levels = await admin.classLevel.findMany({
      where: { schoolId: RIVERSIDE_ID, deletedAt: null },
      orderBy: { orderIndex: "asc" },
    });
    expect(levels.map((l) => l.orderIndex)).toEqual([0, 1, 2, 3]);
    {
      const data = unwrap(await markLevelsComplete({ skip: false }));
      expect(data.stepStatuses[OnboardingStep.Levels]).toBe(
        OnboardingStepStatus.Completed,
      );
      expect(data.currentStep).toBe(OnboardingStep.Skills);
      expect(data.completedWizard).toBe(false);
    }

    // 4. Skills — apply skills under the position-0 level, then mark complete
    const positionZero = levels[0]!;
    unwrap(await applyAssaSkillsForLevel({ levelId: positionZero.id }));
    const insertedSkills = await admin.skill.findMany({
      where: { schoolId: RIVERSIDE_ID, levelId: positionZero.id, isArchived: false },
    });
    expect(insertedSkills.length).toBeGreaterThan(0);

    {
      const data = unwrap(await markSkillsComplete({ skip: false }));
      // The Chunk 6 short-circuit reversal: Skills now advances to
      // `classes` (the Sprint 5 stub) rather than calling complete().
      expect(data.currentStep).toBe(OnboardingStep.Classes);
      expect(data.stepStatuses[OnboardingStep.Skills]).toBe(
        OnboardingStepStatus.Completed,
      );
      expect(data.completedWizard).toBe(false);
      expect(data.completedAt).toBeNull();
    }

    // 5. Classes stub — skipRemainingOnboarding completes the wizard
    {
      const data = unwrap(await skipRemainingOnboarding());
      expect(data.currentStep).toBe(OnboardingStep.Done);
      expect(data.completedAt).not.toBeNull();
      expect(data.completedWizard).toBe(true);
    }
  });

  test("skip path: walks the same journey skipping every skip-able step", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    // Profile — skip
    {
      const data = unwrap(await markProfileComplete({ skip: true }));
      expect(data.stepStatuses[OnboardingStep.Profile]).toBe(
        OnboardingStepStatus.Skipped,
      );
      expect(data.currentStep).toBe(OnboardingStep.Locations);
    }

    // Locations — cannot be skipped, so the happy path needs one row
    unwrap(
      await addLocation({
        name: "Main Pool",
        addressLine: null,
        suburb: null,
        state: null,
        postcode: null,
        timezone: null,
        notes: null,
      }),
    );
    {
      const data = unwrap(await markLocationsComplete());
      expect(data.stepStatuses[OnboardingStep.Locations]).toBe(
        OnboardingStepStatus.Completed,
      );
      expect(data.currentStep).toBe(OnboardingStep.Levels);
    }

    // Levels — skip
    {
      const data = unwrap(await markLevelsComplete({ skip: true }));
      expect(data.stepStatuses[OnboardingStep.Levels]).toBe(
        OnboardingStepStatus.Skipped,
      );
      expect(data.currentStep).toBe(OnboardingStep.Skills);
    }

    // Skills — skip
    {
      const data = unwrap(await markSkillsComplete({ skip: true }));
      expect(data.stepStatuses[OnboardingStep.Skills]).toBe(
        OnboardingStepStatus.Skipped,
      );
      // Same Chunk 6 contract on the skip path: advances to classes,
      // does not auto-complete the wizard.
      expect(data.currentStep).toBe(OnboardingStep.Classes);
      expect(data.completedAt).toBeNull();
    }

    // Classes stub — finalise
    {
      const data = unwrap(await skipRemainingOnboarding());
      expect(data.currentStep).toBe(OnboardingStep.Done);
      expect(data.completedAt).not.toBeNull();
      expect(data.completedWizard).toBe(true);
    }
  });
});
