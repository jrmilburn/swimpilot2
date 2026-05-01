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

// `revalidatePath` reaches into Next's internals; the wizard uses it
// only for cache busting. Stub it out so the action body doesn't try to
// touch render context that doesn't exist in a unit test process.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { auth } from "@clerk/nextjs/server";
import { prisma } from "../../src/lib/db/client";
import { addLocation } from "../../src/app/s/[schoolSlug]/onboarding/locations/_actions/addLocation";

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
  await admin.$executeRawUnsafe(`DELETE FROM locations`);
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

describe("addLocation", () => {
  test("happy path creates a row in the current tenant", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await addLocation({
      name: "Parramatta Pool",
      addressLine: "46 Park Pde",
      suburb: "Parramatta",
      state: "NSW",
      postcode: "2150",
      timezone: "Australia/Sydney",
      notes: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.schoolId).toBe(RIVERSIDE_ID);
    expect(result.data.name).toBe("Parramatta Pool");

    const row = await admin.location.findUnique({
      where: { id: result.data.id },
    });
    expect(row?.schoolId).toBe(RIVERSIDE_ID);
    expect(row?.suburb).toBe("Parramatta");
  });

  test("empty name is rejected with VALIDATION + fieldErrors.name", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await addLocation({
      name: "",
      addressLine: null,
      suburb: null,
      state: null,
      postcode: null,
      timezone: null,
      notes: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.fieldErrors?.name).toMatch(/name/i);
  });

  test("over-long fields rejected against zod schema", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await addLocation({
      name: "A".repeat(201),
      addressLine: null,
      suburb: null,
      state: null,
      postcode: null,
      timezone: null,
      notes: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.fieldErrors?.name).toBeDefined();
  });

  test("cross-tenant: posting to a slug the user has no membership in 404s before any write", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("coastal"); // SOLO_USER has no membership in coastal

    await expect(
      addLocation({
        name: "Should not land",
        addressLine: null,
        suburb: null,
        state: null,
        postcode: null,
        timezone: null,
        notes: null,
      }),
    ).rejects.toMatchObject({
      digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404/),
    });

    const rows = await admin.location.findMany({
      where: { schoolId: COASTAL_ID },
    });
    expect(rows).toHaveLength(0);
  });
});
