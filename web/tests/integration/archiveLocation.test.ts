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
import { withTenant } from "../../src/lib/db/withTenant";
import * as locationRepository from "../../src/repositories/locationRepository";
import { archiveLocation } from "../../src/app/s/[schoolSlug]/onboarding/locations/_actions/archiveLocation";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const RIVERSIDE_ID = "11111111-1111-1111-1111-111111111111";
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

describe("archiveLocation", () => {
  test("sets deletedAt; subsequent listBySchool excludes it", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const created = await admin.location.create({
      data: {
        schoolId: RIVERSIDE_ID,
        name: "Parramatta Pool",
        createdBy: SOLO_USER,
        updatedBy: SOLO_USER,
      },
    });

    const result = await archiveLocation({ id: created.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.archived).toBe(true);

    const row = await admin.location.findUnique({ where: { id: created.id } });
    expect(row?.deletedAt).not.toBeNull();

    const visible = await withTenant(
      { schoolId: RIVERSIDE_ID, userId: SOLO_USER },
      (tx) => locationRepository.listBySchool(tx),
    );
    expect(visible.find((l) => l.id === created.id)).toBeUndefined();
  });

  test("double-archive is idempotent: second call returns archived: false (silent no-op)", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const created = await admin.location.create({
      data: {
        schoolId: RIVERSIDE_ID,
        name: "Ryde Aquatic",
        createdBy: SOLO_USER,
        updatedBy: SOLO_USER,
      },
    });

    const first = await archiveLocation({ id: created.id });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.archived).toBe(true);

    const second = await archiveLocation({ id: created.id });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.archived).toBe(false);
  });
});
