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
import { addSkill } from "../../src/app/s/[schoolSlug]/onboarding/skills/_actions/addSkill";
import { reorderSkills } from "../../src/app/s/[schoolSlug]/onboarding/skills/_actions/reorderSkills";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const RIVERSIDE_ID = "11111111-1111-1111-1111-111111111111";
const COASTAL_ID = "22222222-2222-2222-2222-222222222222";
const SOLO_USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SOLO_CLERK = "user_solo_test";
const RIVERSIDE_LEVEL_A = "eeeeeeee-eeee-4eee-8eee-00000000000a";
const COASTAL_LEVEL = "eeeeeeee-eeee-4eee-8eee-00000000000b";

async function seed() {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, class_levels, skills, student_skills RESTART IDENTITY CASCADE`,
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
  await admin.$executeRaw`
    INSERT INTO class_levels (id, school_id, name, ratio, order_index, created_by, updated_by, updated_at) VALUES
      (${RIVERSIDE_LEVEL_A}::uuid, ${RIVERSIDE_ID}::uuid, 'Beginner', 6, 0, ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now()),
      (${COASTAL_LEVEL}::uuid, ${COASTAL_ID}::uuid, 'Beginner', 6, 0, ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
}

beforeAll(async () => {
  await seed();
});

beforeEach(async () => {
  vi.mocked(auth).mockReset();
  headerStore.current = new Headers();
  await admin.$executeRawUnsafe(`DELETE FROM skills`);
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

async function seedThree() {
  mockAuth(SOLO_CLERK);
  setSlug("riverside");
  const a = await addSkill({ levelId: RIVERSIDE_LEVEL_A, name: "A" });
  const b = await addSkill({ levelId: RIVERSIDE_LEVEL_A, name: "B" });
  const c = await addSkill({ levelId: RIVERSIDE_LEVEL_A, name: "C" });
  if (!a.ok || !b.ok || !c.ok) throw new Error("seed failed");
  return { a: a.data.id, b: b.data.id, c: c.data.id };
}

describe("reorderSkills", () => {
  test("happy path: writes orderIndex 0..n-1 in the supplied order", async () => {
    const { a, b, c } = await seedThree();

    const result = await reorderSkills({
      levelId: RIVERSIDE_LEVEL_A,
      ids: [c, a, b],
    });
    expect(result.ok).toBe(true);

    const live = await admin.skill.findMany({
      where: { levelId: RIVERSIDE_LEVEL_A, isArchived: false },
      orderBy: { orderIndex: "asc" },
    });
    expect(live.map((s) => s.id)).toEqual([c, a, b]);
    expect(live.map((s) => s.orderIndex)).toEqual([0, 1, 2]);
  });

  test("stale list (count mismatch) returns VALIDATION", async () => {
    const { a, b } = await seedThree();

    const result = await reorderSkills({
      levelId: RIVERSIDE_LEVEL_A,
      ids: [a, b],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toMatch(/out of date/i);
  });

  test("foreign-tenant id returns VALIDATION (membership check fires after RLS hides it)", async () => {
    const { a, b } = await seedThree();

    // Add a foreign skill in coastal.
    const foreignId = "dddddddd-dddd-4ddd-8ddd-000000000001";
    await admin.$executeRaw`
      INSERT INTO skills (id, school_id, level_id, name, order_index,
                          created_by, updated_by, updated_at)
      VALUES (${foreignId}::uuid, ${COASTAL_ID}::uuid, ${COASTAL_LEVEL}::uuid,
              'Foreign', 0, ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
    `;

    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await reorderSkills({
      levelId: RIVERSIDE_LEVEL_A,
      ids: [a, b, foreignId],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toMatch(/unknown skill/i);

    // Foreign row unchanged.
    const row = await admin.skill.findUnique({ where: { id: foreignId } });
    expect(row?.orderIndex).toBe(0);
  });

  test("invalid input (empty ids array) returns VALIDATION", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await reorderSkills({
      levelId: RIVERSIDE_LEVEL_A,
      ids: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("cross-tenant: posting to a slug the user has no membership in 404s", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("coastal");

    await expect(
      reorderSkills({
        levelId: COASTAL_LEVEL,
        ids: ["dddddddd-dddd-4ddd-8ddd-000000000001"],
      }),
    ).rejects.toMatchObject({
      digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404/),
    });
  });
});
