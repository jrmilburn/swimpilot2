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
import { updateLocation } from "../../src/app/s/[schoolSlug]/onboarding/locations/_actions/updateLocation";

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

async function insertLocation(schoolId: string, name: string): Promise<string> {
  const row = await admin.location.create({
    data: {
      schoolId,
      name,
      createdBy: SOLO_USER,
      updatedBy: SOLO_USER,
    },
  });
  return row.id;
}

describe("updateLocation", () => {
  test("partial update mutates only the fields provided", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");
    const id = await insertLocation(RIVERSIDE_ID, "Parramatta Pool");

    const result = await updateLocation({
      id,
      patch: {
        addressLine: "46 Park Pde",
        suburb: "Parramatta",
        state: "NSW",
        postcode: "2150",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.name).toBe("Parramatta Pool");
    expect(result.data.addressLine).toBe("46 Park Pde");

    const row = await admin.location.findUnique({ where: { id } });
    expect(row?.name).toBe("Parramatta Pool");
    expect(row?.suburb).toBe("Parramatta");
  });

  test("cross-tenant: slug A targeting B's id returns NOT_FOUND without mutating", async () => {
    const idB = await insertLocation(COASTAL_ID, "Bondi Pavilion");

    mockAuth(SOLO_CLERK);
    setSlug("riverside"); // SOLO_USER's only membership

    const result = await updateLocation({
      id: idB,
      patch: { name: "Hijacked" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");

    const row = await admin.location.findUnique({ where: { id: idB } });
    expect(row?.name).toBe("Bondi Pavilion");
  });
});
