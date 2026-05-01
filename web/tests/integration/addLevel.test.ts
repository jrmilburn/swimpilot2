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
import { addLevel } from "../../src/app/s/[schoolSlug]/onboarding/levels/_actions/addLevel";

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

beforeAll(async () => {
  await seed();
});

beforeEach(async () => {
  vi.mocked(auth).mockReset();
  headerStore.current = new Headers();
  await admin.$executeRawUnsafe(`DELETE FROM class_levels`);
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

describe("addLevel", () => {
  test("happy path: creates a row with server-assigned orderIndex", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await addLevel({
      name: "Infants",
      ratio: 4,
      defaultProgressionThreshold: 80,
      minAgeMonths: 6,
      maxAgeMonths: 36,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.schoolId).toBe(RIVERSIDE_ID);
    expect(result.data.orderIndex).toBe(0);

    const second = await addLevel({
      name: "Beginner",
      ratio: 6,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.orderIndex).toBe(1);
  });

  test("client-supplied orderIndex is ignored — server appends at end", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    await addLevel({ name: "First", ratio: 4 });
    // Even if the form somehow sent a stale index, the server overwrites
    // it from the live count.
    // The schema strips unknown keys; this is a belt-and-braces check
    // that the action layer doesn't trust them.
    const result = await addLevel({
      name: "Second",
      ratio: 6,
      orderIndex: 99,
    } as unknown as { name: string; ratio: number });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.orderIndex).toBe(1);
  });

  test("name uniqueness collision throws fieldErrors.name", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    await addLevel({ name: "Duplicate", ratio: 4 });
    const result = await addLevel({ name: "Duplicate", ratio: 6 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.fieldErrors?.name).toMatch(/already exists/i);
  });

  test("min > max age is rejected with fieldErrors.maxAgeMonths", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await addLevel({
      name: "Bad ages",
      ratio: 4,
      minAgeMonths: 60,
      maxAgeMonths: 12,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.fieldErrors?.maxAgeMonths).toMatch(
      /at least the minimum/i,
    );
  });

  test("cross-tenant: posting to a slug the user has no membership in 404s", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("coastal");

    await expect(
      addLevel({ name: "Should not land", ratio: 4 }),
    ).rejects.toMatchObject({
      digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404/),
    });

    const rows = await admin.classLevel.findMany({
      where: { schoolId: COASTAL_ID },
    });
    expect(rows).toHaveLength(0);
  });
});
