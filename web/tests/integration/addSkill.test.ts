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

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const RIVERSIDE_ID = "11111111-1111-1111-1111-111111111111";
const COASTAL_ID = "22222222-2222-2222-2222-222222222222";
const SOLO_USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SOLO_CLERK = "user_solo_test";
const RIVERSIDE_LEVEL_A = "eeeeeeee-eeee-4eee-8eee-00000000000a";
const RIVERSIDE_LEVEL_A2 = "eeeeeeee-eeee-4eee-8eee-00000000000c";
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
      (${RIVERSIDE_LEVEL_A2}::uuid, ${RIVERSIDE_ID}::uuid, 'Intermediate', 8, 1, ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now()),
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

describe("addSkill", () => {
  test("happy path: appends with server-assigned orderIndex", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const first = await addSkill({
      levelId: RIVERSIDE_LEVEL_A,
      name: "Streamline",
      description: "Glide off the wall in a streamline.",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.schoolId).toBe(RIVERSIDE_ID);
    expect(first.data.levelId).toBe(RIVERSIDE_LEVEL_A);
    expect(first.data.orderIndex).toBe(0);
    expect(first.data.description).toBe("Glide off the wall in a streamline.");

    const second = await addSkill({
      levelId: RIVERSIDE_LEVEL_A,
      name: "Kick",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.orderIndex).toBe(1);

    // Third skill under a different level appends at index 0 of *that* level.
    const third = await addSkill({
      levelId: RIVERSIDE_LEVEL_A2,
      name: "Streamline",
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.data.orderIndex).toBe(0);
    expect(third.data.levelId).toBe(RIVERSIDE_LEVEL_A2);
  });

  test("name-uniqueness collision under same level returns fieldErrors.name", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");
    await addSkill({ levelId: RIVERSIDE_LEVEL_A, name: "Streamline" });

    const dup = await addSkill({
      levelId: RIVERSIDE_LEVEL_A,
      name: "Streamline",
    });
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.error.code).toBe("VALIDATION");
    expect(dup.error.fieldErrors?.name).toMatch(/already exists/i);
  });

  test("validation: empty name returns fieldErrors.name", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await addSkill({
      levelId: RIVERSIDE_LEVEL_A,
      name: "   ",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.fieldErrors?.name).toMatch(/required/i);
  });

  test("levelId belonging to another school returns NOT_FOUND", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await addSkill({
      levelId: COASTAL_LEVEL,
      name: "Streamline",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");

    // Nothing was written.
    const rows = await admin.skill.findMany({});
    expect(rows).toHaveLength(0);
  });

  test("cross-tenant: posting to a slug the user has no membership in 404s", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("coastal");

    await expect(
      addSkill({ levelId: COASTAL_LEVEL, name: "Streamline" }),
    ).rejects.toMatchObject({
      digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404/),
    });

    const rows = await admin.skill.findMany({
      where: { schoolId: COASTAL_ID },
    });
    expect(rows).toHaveLength(0);
  });
});
