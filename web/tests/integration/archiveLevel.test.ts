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
import { archiveLevel } from "../../src/app/s/[schoolSlug]/onboarding/levels/_actions/archiveLevel";

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

async function makeLevels(names: string[]) {
  const ids: string[] = [];
  for (let i = 0; i < names.length; i++) {
    const row = await admin.classLevel.create({
      data: {
        schoolId: RIVERSIDE_ID,
        name: names[i]!,
        ratio: 4,
        orderIndex: i,
        createdBy: SOLO_USER,
        updatedBy: SOLO_USER,
      },
    });
    ids.push(row.id);
  }
  return ids;
}

describe("archiveLevel", () => {
  test("happy path: sets deletedAt and compacts surviving rows", async () => {
    const [a, b, c] = await makeLevels(["A", "B", "C"]);

    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await archiveLevel({ id: b! });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.archived).toBe(true);

    const archived = await admin.classLevel.findUnique({ where: { id: b! } });
    expect(archived?.deletedAt).not.toBeNull();

    const survivors = await admin.classLevel.findMany({
      where: { schoolId: RIVERSIDE_ID, deletedAt: null },
      orderBy: { orderIndex: "asc" },
    });
    expect(survivors.map((l) => l.id)).toEqual([a, c]);
    expect(survivors.map((l) => l.orderIndex)).toEqual([0, 1]);
  });

  test("idempotent on second archive of the same id", async () => {
    const [a] = await makeLevels(["Solo"]);

    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const first = await archiveLevel({ id: a! });
    expect(first.ok && first.data.archived).toBe(true);

    const second = await archiveLevel({ id: a! });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.archived).toBe(false);
  });
});
