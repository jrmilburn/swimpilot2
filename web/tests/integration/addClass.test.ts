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
import { WeekDay } from "../../src/domain/enums";
import { addClass } from "../../src/app/s/[schoolSlug]/onboarding/classes/_actions/addClass";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const RIVERSIDE_ID = "11111111-1111-1111-1111-111111111111";
const COASTAL_ID = "22222222-2222-2222-2222-222222222222";
const SOLO_USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SOLO_CLERK = "user_solo_test";
const LOCATION_R = "aaaaaaaa-aaaa-4aaa-8aaa-00000000000a";
const LOCATION_C = "aaaaaaaa-aaaa-4aaa-8aaa-00000000000b";
const LEVEL_R = "eeeeeeee-eeee-4eee-8eee-00000000000a";
const LEVEL_C = "eeeeeeee-eeee-4eee-8eee-00000000000b";

async function seed() {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations, class_levels, classes RESTART IDENTITY CASCADE`,
  );
  await admin.$executeRaw`
    INSERT INTO users (id, clerk_id, email, name, updated_at) VALUES
      (${SOLO_USER}::uuid, ${SOLO_CLERK}, 'solo@example.com', 'Solo', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${RIVERSIDE_ID}::uuid, 'riverside', 'Riverside', 'Australia/Sydney', 'AUD', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now()),
      (${COASTAL_ID}::uuid,   'coastal',   'Coastal',   'Australia/Sydney', 'AUD', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${RIVERSIDE_ID}::uuid, ${SOLO_USER}::uuid, 'owner', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO locations (id, school_id, name, created_by, updated_by, updated_at) VALUES
      (${LOCATION_R}::uuid, ${RIVERSIDE_ID}::uuid, 'R Pool', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now()),
      (${LOCATION_C}::uuid, ${COASTAL_ID}::uuid,   'C Pool', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO class_levels (id, school_id, name, ratio, order_index, created_by, updated_by, updated_at) VALUES
      (${LEVEL_R}::uuid, ${RIVERSIDE_ID}::uuid, 'R Infants', 4, 0, ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now()),
      (${LEVEL_C}::uuid, ${COASTAL_ID}::uuid,   'C Infants', 6, 0, ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
}

beforeAll(async () => {
  await seed();
});

beforeEach(async () => {
  vi.mocked(auth).mockReset();
  headerStore.current = new Headers();
  await admin.$executeRawUnsafe(`DELETE FROM classes`);
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

describe("addClass", () => {
  test("happy path: creates class with correct school + day + time", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await addClass({
      levelId: LEVEL_R,
      locationId: LOCATION_R,
      dayOfWeek: WeekDay.Monday,
      startTime: "16:30",
      durationMinutes: 30,
      capacity: 4,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.schoolId).toBe(RIVERSIDE_ID);
    expect(result.data.levelId).toBe(LEVEL_R);
    expect(result.data.locationId).toBe(LOCATION_R);
    expect(result.data.startTime).toBe("16:30:00");
    expect(result.data.dayOfWeek).toBe(WeekDay.Monday);
    expect(result.data.capacity).toBe(4);
  });

  test("capacity > level.ratio rejects with trigger-matching message + capacity field error", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await addClass({
      levelId: LEVEL_R,
      locationId: LOCATION_R,
      dayOfWeek: WeekDay.Monday,
      startTime: "16:30",
      durationMinutes: 30,
      capacity: 5, // ratio is 4
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toMatch(
      /class\.capacity \(5\) cannot exceed level\.ratio \(4\)/,
    );
    expect(result.error.fieldErrors?.capacity).toMatch(
      /class\.capacity \(5\) cannot exceed level\.ratio \(4\)/,
    );
  });

  test("cross-tenant levelId surfaces NotFound, no row created", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await addClass({
      levelId: LEVEL_C, // belongs to Coastal
      locationId: LOCATION_R,
      dayOfWeek: WeekDay.Tuesday,
      startTime: "17:00",
      durationMinutes: 30,
      capacity: 4,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");

    const rows = await admin.class.findMany({ where: { schoolId: RIVERSIDE_ID } });
    expect(rows).toHaveLength(0);
  });

  test("cross-tenant locationId surfaces NotFound", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await addClass({
      levelId: LEVEL_R,
      locationId: LOCATION_C, // belongs to Coastal
      dayOfWeek: WeekDay.Tuesday,
      startTime: "17:00",
      durationMinutes: 30,
      capacity: 4,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("invalid startTime regex rejects with field error", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await addClass({
      levelId: LEVEL_R,
      locationId: LOCATION_R,
      dayOfWeek: WeekDay.Monday,
      startTime: "9:5", // invalid
      durationMinutes: 30,
      capacity: 4,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.fieldErrors?.startTime).toBeDefined();
  });

  test("durationMinutes not divisible by 5 rejects", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await addClass({
      levelId: LEVEL_R,
      locationId: LOCATION_R,
      dayOfWeek: WeekDay.Monday,
      startTime: "16:30",
      durationMinutes: 33,
      capacity: 4,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.fieldErrors?.durationMinutes).toBeDefined();
  });
});
