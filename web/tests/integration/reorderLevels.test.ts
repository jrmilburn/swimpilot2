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
import { reorderLevels } from "../../src/app/s/[schoolSlug]/onboarding/levels/_actions/reorderLevels";

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

async function makeLevelIn(schoolId: string, name: string, orderIndex: number) {
  const row = await admin.classLevel.create({
    data: {
      schoolId,
      name,
      ratio: 4,
      orderIndex,
      createdBy: SOLO_USER,
      updatedBy: SOLO_USER,
    },
  });
  return row.id;
}

describe("reorderLevels", () => {
  test("happy path writes 0..n-1 in the supplied order", async () => {
    const a = await makeLevelIn(RIVERSIDE_ID, "A", 0);
    const b = await makeLevelIn(RIVERSIDE_ID, "B", 1);
    const c = await makeLevelIn(RIVERSIDE_ID, "C", 2);

    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await reorderLevels({ ids: [c, a, b] });
    expect(result.ok).toBe(true);

    const list = await admin.classLevel.findMany({
      where: { schoolId: RIVERSIDE_ID },
      orderBy: { orderIndex: "asc" },
    });
    expect(list.map((l) => l.id)).toEqual([c, a, b]);
  });

  test("count mismatch (stale list) is VALIDATION", async () => {
    const a = await makeLevelIn(RIVERSIDE_ID, "A", 0);
    await makeLevelIn(RIVERSIDE_ID, "B", 1);
    await makeLevelIn(RIVERSIDE_ID, "C", 2);

    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await reorderLevels({ ids: [a] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toMatch(/out of date/i);
  });

  test("cross-tenant id mixed in is VALIDATION (unknown level)", async () => {
    const a = await makeLevelIn(RIVERSIDE_ID, "A", 0);
    const b = await makeLevelIn(RIVERSIDE_ID, "B", 1);
    const foreign = await makeLevelIn(COASTAL_ID, "Foreign", 0);

    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    // 2 live in riverside, 2 ids supplied (count check passes), but
    // `foreign` is not in liveIds → unknown level error.
    const result = await reorderLevels({ ids: [a, foreign] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");

    // The original orderings are unchanged because validation fires
    // before any write.
    const aRow = await admin.classLevel.findUnique({ where: { id: a } });
    const bRow = await admin.classLevel.findUnique({ where: { id: b } });
    const fRow = await admin.classLevel.findUnique({ where: { id: foreign } });
    expect(aRow?.orderIndex).toBe(0);
    expect(bRow?.orderIndex).toBe(1);
    expect(fRow?.orderIndex).toBe(0);
  });
});
