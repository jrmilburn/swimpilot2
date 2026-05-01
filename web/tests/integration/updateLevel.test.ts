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
import { updateLevel } from "../../src/app/s/[schoolSlug]/onboarding/levels/_actions/updateLevel";

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

async function createLevel(schoolId: string, name: string) {
  return admin.classLevel.create({
    data: {
      schoolId,
      name,
      ratio: 6,
      orderIndex: 0,
      createdBy: SOLO_USER,
      updatedBy: SOLO_USER,
    },
  });
}

describe("updateLevel", () => {
  test("partial update mutates only the fields provided", async () => {
    const level = await createLevel(RIVERSIDE_ID, "Beginner");

    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await updateLevel({
      id: level.id,
      patch: { ratio: 4, defaultProgressionThreshold: 90 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ratio).toBe(4);
    expect(result.data.defaultProgressionThreshold).toBe(90);
    expect(result.data.name).toBe("Beginner");
  });

  test("name conflict surfaces as fieldErrors.name", async () => {
    await createLevel(RIVERSIDE_ID, "Infants");
    const beginner = await createLevel(RIVERSIDE_ID, "Beginner");

    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await updateLevel({
      id: beginner.id,
      patch: { name: "Infants" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.fieldErrors?.name).toMatch(/already exists/i);
  });

  test("cross-tenant id 404s before mutating", async () => {
    const foreign = await createLevel(COASTAL_ID, "Foreign");

    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await updateLevel({
      id: foreign.id,
      patch: { ratio: 1 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");

    const row = await admin.classLevel.findUnique({
      where: { id: foreign.id },
    });
    expect(row?.ratio).toBe(6);
  });
});
