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

// Clerk reads these at module-init time. Mocked below; values are placeholders.
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??=
  "pk_test_dGVzdC10ZXN0LXRlc3QudGVzdC50ZXN0LWlu";
process.env.CLERK_SECRET_KEY ??= "sk_test_dGVzdC10ZXN0LXRlc3QtdGVzdA";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  SignOutButton: ({ children }: { children: React.ReactNode }) => children,
}));

// HomePage reads the swp_last_school cookie via next/headers' cookies().
// Stub it with a per-test cookie store.
const cookieStore: { current: Map<string, string> } = {
  current: new Map(),
};
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => {
      const value = cookieStore.current.get(name);
      return value === undefined ? undefined : { name, value };
    },
  })),
}));

import { auth } from "@clerk/nextjs/server";
import { prisma } from "../../src/lib/db/client";
import HomePage from "../../src/app/page";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const RIVERSIDE_ID = "11111111-1111-1111-1111-111111111111";
const COASTAL_ID = "22222222-2222-2222-2222-222222222222";
const SOLO_USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const MULTI_USER = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

const MULTI_CLERK = "user_multi_test";

async function seed() {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations RESTART IDENTITY CASCADE`,
  );

  await admin.$executeRaw`
    INSERT INTO users (id, clerk_id, email, name, updated_at) VALUES
      (${SOLO_USER}::uuid,  'user_solo_test',  'solo@example.com',  'Solo User',  now()),
      (${MULTI_USER}::uuid, ${MULTI_CLERK},    'multi@example.com', 'Multi User', now())
  `;

  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${RIVERSIDE_ID}::uuid, 'riverside', 'Riverside Swim School', 'Australia/Sydney', 'AUD', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now()),
      (${COASTAL_ID}::uuid,   'coastal',   'Coastal Swim School',   'Australia/Sydney', 'AUD', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;

  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${RIVERSIDE_ID}::uuid, ${MULTI_USER}::uuid, 'manager', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now()),
      (gen_random_uuid(), ${COASTAL_ID}::uuid,   ${MULTI_USER}::uuid, 'teacher', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
}

beforeAll(async () => {
  await seed();
});

beforeEach(() => {
  vi.mocked(auth).mockReset();
  cookieStore.current = new Map();
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

function mockAuth(clerkId: string) {
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);
}

async function renderToString(node: unknown): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  return renderToStaticMarkup(node as never);
}

describe("/ landing page: swp_last_school cookie", () => {
  test("multi-membership + no cookie → renders the picker", async () => {
    mockAuth(MULTI_CLERK);

    const node = await HomePage();
    const html = await renderToString(node);
    expect(html).toContain("Choose a school");
  });

  test("multi-membership + cookie matches a membership → redirects to that school", async () => {
    mockAuth(MULTI_CLERK);
    cookieStore.current.set("swp_last_school", "coastal");

    await expect(HomePage()).rejects.toMatchObject({
      digest: expect.stringMatching(/NEXT_REDIRECT.*\/s\/coastal/),
    });
  });

  test("multi-membership + cookie names a non-member slug → falls through to picker", async () => {
    mockAuth(MULTI_CLERK);
    cookieStore.current.set("swp_last_school", "somewhere-else");

    const node = await HomePage();
    const html = await renderToString(node);
    expect(html).toContain("Choose a school");
    // And specifically did NOT redirect to the bogus slug.
    expect(html).not.toContain('href="/s/somewhere-else"');
  });
});
