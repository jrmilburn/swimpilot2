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
import { ASSA_SKILL_TEMPLATE } from "../../src/domain/assaSkillTemplate";
import { addSkill } from "../../src/app/s/[schoolSlug]/onboarding/skills/_actions/addSkill";
import { applyAssaSkillsForLevel } from "../../src/app/s/[schoolSlug]/onboarding/skills/_actions/applyAssaSkillsForLevel";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const RIVERSIDE_ID = "11111111-1111-1111-1111-111111111111";
const COASTAL_ID = "22222222-2222-2222-2222-222222222222";
const SOLO_USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SOLO_CLERK = "user_solo_test";

const RIVERSIDE_LEVEL_BEGINNER = "eeeeeeee-eeee-4eee-8eee-00000000000a"; // orderIndex 1
const RIVERSIDE_LEVEL_CUSTOM = "eeeeeeee-eeee-4eee-8eee-00000000000c"; // orderIndex 4
const COASTAL_LEVEL = "eeeeeeee-eeee-4eee-8eee-00000000000b"; // orderIndex 0

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
  // Riverside Beginner is at orderIndex 1, Custom at 4.
  await admin.$executeRaw`
    INSERT INTO class_levels (id, school_id, name, ratio, order_index, created_by, updated_by, updated_at) VALUES
      (${RIVERSIDE_LEVEL_BEGINNER}::uuid, ${RIVERSIDE_ID}::uuid, 'Beginner', 6, 1, ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now()),
      (${RIVERSIDE_LEVEL_CUSTOM}::uuid, ${RIVERSIDE_ID}::uuid, 'Squad', 8, 4, ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now()),
      (${COASTAL_LEVEL}::uuid, ${COASTAL_ID}::uuid, 'Infants', 4, 0, ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
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

describe("applyAssaSkillsForLevel", () => {
  test("happy path: inserts the position-1 ASSA template under an empty Beginner level", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await applyAssaSkillsForLevel({
      levelId: RIVERSIDE_LEVEL_BEGINNER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.applied).toBe(ASSA_SKILL_TEMPLATE[1].length);

    const rows = await admin.skill.findMany({
      where: { levelId: RIVERSIDE_LEVEL_BEGINNER },
      orderBy: { orderIndex: "asc" },
    });
    expect(rows.map((r) => r.name)).toEqual(
      ASSA_SKILL_TEMPLATE[1].map((s) => s.name),
    );
    expect(rows.map((r) => r.orderIndex)).toEqual(
      ASSA_SKILL_TEMPLATE[1].map((_, i) => i),
    );
  });

  test("level at orderIndex 4 (no template) returns VALIDATION._form", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await applyAssaSkillsForLevel({
      levelId: RIVERSIDE_LEVEL_CUSTOM,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.fieldErrors?._form).toMatch(/no default skills/i);

    const rows = await admin.skill.findMany({
      where: { levelId: RIVERSIDE_LEVEL_CUSTOM },
    });
    expect(rows).toHaveLength(0);
  });

  test("level already populated returns VALIDATION._form (idempotency guard)", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");
    await addSkill({
      levelId: RIVERSIDE_LEVEL_BEGINNER,
      name: "Pre-existing skill",
    });

    const result = await applyAssaSkillsForLevel({
      levelId: RIVERSIDE_LEVEL_BEGINNER,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.fieldErrors?._form).toMatch(/already has skills/i);

    const rows = await admin.skill.findMany({
      where: { levelId: RIVERSIDE_LEVEL_BEGINNER },
    });
    expect(rows).toHaveLength(1);
  });

  test("levelId belonging to another school returns NOT_FOUND", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await applyAssaSkillsForLevel({
      levelId: COASTAL_LEVEL,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");

    const rows = await admin.skill.findMany({});
    expect(rows).toHaveLength(0);
  });

  test("cross-tenant: posting to a slug the user has no membership in 404s", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("coastal");

    await expect(
      applyAssaSkillsForLevel({ levelId: COASTAL_LEVEL }),
    ).rejects.toMatchObject({
      digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404/),
    });

    const rows = await admin.skill.findMany({
      where: { schoolId: COASTAL_ID },
    });
    expect(rows).toHaveLength(0);
  });
});
