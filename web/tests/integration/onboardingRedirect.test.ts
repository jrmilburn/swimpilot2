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

const COMPLETE_SCHOOL = "11111111-1111-1111-1111-111111111111";
const INCOMPLETE_SCHOOL = "22222222-2222-2222-2222-222222222222";
const SECOND_INCOMPLETE_SCHOOL = "33333333-3333-3333-3333-333333333333";

const SOLO_COMPLETE_USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SOLO_INCOMPLETE_USER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const MULTI_USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const SOLO_COMPLETE_CLERK = "user_solo_complete";
const SOLO_INCOMPLETE_CLERK = "user_solo_incomplete";
const MULTI_CLERK = "user_multi_redirect";

async function seed() {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations RESTART IDENTITY CASCADE`,
  );
  await admin.$executeRaw`
    INSERT INTO users (id, clerk_id, email, name, updated_at) VALUES
      (${SOLO_COMPLETE_USER}::uuid,   ${SOLO_COMPLETE_CLERK},   'sc@example.com', 'SC', now()),
      (${SOLO_INCOMPLETE_USER}::uuid, ${SOLO_INCOMPLETE_CLERK}, 'si@example.com', 'SI', now()),
      (${MULTI_USER}::uuid,           ${MULTI_CLERK},           'm@example.com',  'M',  now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${COMPLETE_SCHOOL}::uuid,            'complete-school',  'Complete School',   'Australia/Sydney', 'AUD', ${SOLO_COMPLETE_USER}::uuid, ${SOLO_COMPLETE_USER}::uuid, now()),
      (${INCOMPLETE_SCHOOL}::uuid,          'incomplete-school','Incomplete School', 'Australia/Sydney', 'AUD', ${SOLO_INCOMPLETE_USER}::uuid, ${SOLO_INCOMPLETE_USER}::uuid, now()),
      (${SECOND_INCOMPLETE_SCHOOL}::uuid,   'second-incomplete','Second Incomplete', 'Australia/Sydney', 'AUD', ${SOLO_INCOMPLETE_USER}::uuid, ${SOLO_INCOMPLETE_USER}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${COMPLETE_SCHOOL}::uuid,          ${SOLO_COMPLETE_USER}::uuid,   'owner', ${SOLO_COMPLETE_USER}::uuid, ${SOLO_COMPLETE_USER}::uuid, now()),
      (gen_random_uuid(), ${INCOMPLETE_SCHOOL}::uuid,        ${SOLO_INCOMPLETE_USER}::uuid, 'owner', ${SOLO_INCOMPLETE_USER}::uuid, ${SOLO_INCOMPLETE_USER}::uuid, now()),
      (gen_random_uuid(), ${INCOMPLETE_SCHOOL}::uuid,        ${MULTI_USER}::uuid,           'manager', ${SOLO_INCOMPLETE_USER}::uuid, ${SOLO_INCOMPLETE_USER}::uuid, now()),
      (gen_random_uuid(), ${SECOND_INCOMPLETE_SCHOOL}::uuid, ${MULTI_USER}::uuid,           'manager', ${SOLO_INCOMPLETE_USER}::uuid, ${SOLO_INCOMPLETE_USER}::uuid, now())
  `;

  // Trigger fired for each school INSERT — every school now has a row.
  // Mark Complete School completed; leave the others mid-wizard at the
  // `locations` step so we can tell the wizard URL apart from the default.
  await admin.$executeRaw`
    UPDATE onboarding_progress
       SET completed_at = now(),
           current_step = 'done',
           step_statuses = jsonb_build_object(
             'profile','completed','locations','completed','levels','completed',
             'skills','completed','classes','completed','teachers','completed',
             'billing','completed','channels','completed','import','completed'
           ),
           updated_at = now()
     WHERE school_id = ${COMPLETE_SCHOOL}::uuid
  `;
  await admin.$executeRaw`
    UPDATE onboarding_progress
       SET completed_at = NULL,
           current_step = 'locations',
           updated_at = now()
     WHERE school_id IN (${INCOMPLETE_SCHOOL}::uuid, ${SECOND_INCOMPLETE_SCHOOL}::uuid)
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

describe("/ landing page: onboarding-aware redirect", () => {
  test("single membership, onboarding complete → redirects to /s/<slug>", async () => {
    mockAuth(SOLO_COMPLETE_CLERK);
    await expect(HomePage()).rejects.toMatchObject({
      digest: expect.stringMatching(/NEXT_REDIRECT.*\/s\/complete-school(?!\/onboarding)/),
    });
  });

  test("single membership, onboarding incomplete → redirects to wizard at current step", async () => {
    mockAuth(SOLO_INCOMPLETE_CLERK);
    await expect(HomePage()).rejects.toMatchObject({
      digest: expect.stringMatching(
        /NEXT_REDIRECT.*\/s\/incomplete-school\/onboarding\/locations/,
      ),
    });
  });

  test("multi-membership with last-school cookie pointing at incomplete school → redirects to wizard", async () => {
    mockAuth(MULTI_CLERK);
    cookieStore.current.set("swp_last_school", "second-incomplete");
    await expect(HomePage()).rejects.toMatchObject({
      digest: expect.stringMatching(
        /NEXT_REDIRECT.*\/s\/second-incomplete\/onboarding\/locations/,
      ),
    });
  });
});
