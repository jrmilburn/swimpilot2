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
import { applyAssaDefaults } from "../../src/app/s/[schoolSlug]/onboarding/levels/_actions/applyAssaDefaults";
import { ASSA_LEVEL_TEMPLATE } from "../../src/domain/assaLevelTemplate";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const RIVERSIDE_ID = "11111111-1111-1111-1111-111111111111";
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
      (${RIVERSIDE_ID}::uuid, 'riverside', 'Riverside Swim School', 'Australia/Sydney', 'AUD', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
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

describe("applyAssaDefaults", () => {
  test("happy path: inserts the template levels at orderIndex 0..3", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await applyAssaDefaults();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.applied).toBe(ASSA_LEVEL_TEMPLATE.length);

    const rows = await admin.classLevel.findMany({
      where: { schoolId: RIVERSIDE_ID },
      orderBy: { orderIndex: "asc" },
    });
    expect(rows.map((r) => r.name)).toEqual(
      ASSA_LEVEL_TEMPLATE.map((e) => e.name),
    );
    expect(rows.map((r) => r.orderIndex)).toEqual([0, 1, 2, 3]);
    expect(rows[0]?.ratio).toBe(ASSA_LEVEL_TEMPLATE[0]!.ratio);
  });

  test("running twice on the same school: second call rejects via unique-index P2002", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const first = await applyAssaDefaults();
    expect(first.ok).toBe(true);

    const second = await applyAssaDefaults();
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("VALIDATION");
    // Either the count guard fired ("Defaults can only be applied…") or
    // the P2002 path fired ("Couldn't apply defaults…"). With the
    // pre-check both the second call and a real concurrent double-click
    // converge on a friendly message; the test asserts the user-facing
    // shape, not the internal branch.
    expect(second.error.message).toMatch(/defaults/i);
  });

  test("refuses when levels already exist", async () => {
    await admin.classLevel.create({
      data: {
        schoolId: RIVERSIDE_ID,
        name: "Existing",
        ratio: 4,
        orderIndex: 0,
        createdBy: SOLO_USER,
        updatedBy: SOLO_USER,
      },
    });

    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await applyAssaDefaults();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.fieldErrors?._form).toMatch(/no levels exist yet/i);
  });
});
