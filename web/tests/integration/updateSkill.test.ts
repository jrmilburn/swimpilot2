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
import { updateSkill } from "../../src/app/s/[schoolSlug]/onboarding/skills/_actions/updateSkill";

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

async function seedRiversideSkill(name: string, description?: string) {
  mockAuth(SOLO_CLERK);
  setSlug("riverside");
  const result = await addSkill({
    levelId: RIVERSIDE_LEVEL_A,
    name,
    ...(description ? { description } : {}),
  });
  if (!result.ok) throw new Error("seed failed");
  return result.data.id;
}

describe("updateSkill", () => {
  test("happy path: rename + update description leaves levelId / orderIndex untouched", async () => {
    const id = await seedRiversideSkill("Streamline", "old description");

    const result = await updateSkill({
      id,
      patch: { name: "Glide", description: "new description" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.name).toBe("Glide");
    expect(result.data.description).toBe("new description");
    expect(result.data.levelId).toBe(RIVERSIDE_LEVEL_A);
    expect(result.data.orderIndex).toBe(0);
  });

  test("setting description to null clears it", async () => {
    const id = await seedRiversideSkill("Streamline", "old description");

    const result = await updateSkill({
      id,
      patch: { description: null },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.description).toBeNull();
  });

  test("rename collision returns fieldErrors.name", async () => {
    await seedRiversideSkill("Streamline");
    const id = await seedRiversideSkill("Glide");

    const result = await updateSkill({
      id,
      patch: { name: "Streamline" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.fieldErrors?.name).toMatch(/already exists/i);
  });

  test("unknown id returns NOT_FOUND", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await updateSkill({
      id: "dddddddd-dddd-4ddd-8ddd-000000000099",
      patch: { name: "Anything" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("updating a skill belonging to another tenant returns NOT_FOUND (RLS hides it)", async () => {
    // Insert a coastal skill via admin.
    const foreignId = "dddddddd-dddd-4ddd-8ddd-000000000001";
    await admin.$executeRaw`
      INSERT INTO skills (id, school_id, level_id, name, order_index,
                          created_by, updated_by, updated_at)
      VALUES (${foreignId}::uuid, ${COASTAL_ID}::uuid, ${COASTAL_LEVEL}::uuid,
              'Foreign', 0, ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
    `;

    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await updateSkill({
      id: foreignId,
      patch: { name: "Tampered" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");

    // Foreign row unchanged.
    const row = await admin.skill.findUnique({ where: { id: foreignId } });
    expect(row?.name).toBe("Foreign");
  });

  test("levelId in the patch is silently ignored — schema strips unknown keys", async () => {
    const id = await seedRiversideSkill("Streamline");

    // The patch schema doesn't accept levelId; passing it must not move
    // the skill across levels.
    const result = await updateSkill({
      id,
      patch: { name: "Streamline", levelId: COASTAL_LEVEL } as unknown as {
        name: string;
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.levelId).toBe(RIVERSIDE_LEVEL_A);
  });
});
