import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

// Clerk reads these at module-init time when `@clerk/nextjs/server` is
// loaded. The values are placeholders for the test environment — `auth`
// and `currentUser` are mocked below so they're never used to talk to
// Clerk. They MUST be set before importing anything that pulls in Clerk.
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??=
  "pk_test_dGVzdC10ZXN0LXRlc3QudGVzdC50ZXN0LWlu";
process.env.CLERK_SECRET_KEY ??= "sk_test_dGVzdC10ZXN0LXRlc3QtdGVzdA";

vi.mock("@clerk/nextjs/server", async () => {
  return {
    auth: vi.fn(),
    currentUser: vi.fn(),
  };
});

vi.mock("@clerk/nextjs", () => ({
  SignOutButton: ({ children }: { children: React.ReactNode }) => children,
}));

import { auth, currentUser } from "@clerk/nextjs/server";
import { prisma } from "../../src/lib/db/client";
import { resolveTenant } from "../../src/lib/auth/resolveTenant";
import { requireTenant } from "../../src/lib/auth/requireTenant";
import { withTenant } from "../../src/lib/db/withTenant";
import { NotFoundError, ForbiddenError } from "../../src/lib/errors";
import HomePage from "../../src/app/page";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const RIVERSIDE_ID = "11111111-1111-1111-1111-111111111111";
const COASTAL_ID = "22222222-2222-2222-2222-222222222222";
const SOLO_USER = "cccccccc-cccc-cccc-cccc-cccccccccccc"; // member of riverside only
const NO_SCHOOL_USER = "dddddddd-dddd-dddd-dddd-dddddddddddd"; // no memberships
const MULTI_USER = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"; // both schools

const SOLO_CLERK = "user_solo_test";
const NO_SCHOOL_CLERK = "user_noschool_test";
const MULTI_CLERK = "user_multi_test";

async function seed() {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations RESTART IDENTITY CASCADE`,
  );

  await admin.$executeRaw`
    INSERT INTO users (id, clerk_id, email, name, updated_at) VALUES
      (${SOLO_USER}::uuid,      ${SOLO_CLERK},      'solo@example.com',     'Solo User',   now()),
      (${NO_SCHOOL_USER}::uuid, ${NO_SCHOOL_CLERK}, 'noschool@example.com', 'No School',   now()),
      (${MULTI_USER}::uuid,     ${MULTI_CLERK},     'multi@example.com',    'Multi User',  now())
  `;

  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${RIVERSIDE_ID}::uuid, 'riverside', 'Riverside Swim School', 'Australia/Sydney', 'AUD', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now()),
      (${COASTAL_ID}::uuid,   'coastal',   'Coastal Swim School',   'Australia/Sydney', 'AUD', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;

  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${RIVERSIDE_ID}::uuid, ${SOLO_USER}::uuid,  'owner',   ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now()),
      (gen_random_uuid(), ${RIVERSIDE_ID}::uuid, ${MULTI_USER}::uuid, 'manager', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now()),
      (gen_random_uuid(), ${COASTAL_ID}::uuid,   ${MULTI_USER}::uuid, 'teacher', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
}

beforeAll(async () => {
  await seed();
});

beforeEach(() => {
  vi.mocked(auth).mockReset();
  vi.mocked(currentUser).mockReset();
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

function mockAuth(clerkId: string | null) {
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);
}

describe("resolveTenant()", () => {
  test("returns context for a school the user is a member of", async () => {
    const ctx = await resolveTenant("riverside", SOLO_USER);
    expect(ctx).toEqual({
      schoolId: RIVERSIDE_ID,
      schoolName: "Riverside Swim School",
      role: "owner",
    });
  });

  test("throws NotFoundError when slug doesn't exist", async () => {
    await expect(
      resolveTenant("does-not-exist", SOLO_USER),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("throws ForbiddenError when school exists but user has no membership", async () => {
    await expect(
      resolveTenant("coastal", SOLO_USER),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("/ landing page", () => {
  test("user with one membership is redirected to /s/[their-slug]", async () => {
    mockAuth(SOLO_CLERK);

    // Next.js redirect() throws an internal error tagged with a digest that
    // includes "NEXT_REDIRECT" and the destination URL.
    await expect(HomePage()).rejects.toMatchObject({
      digest: expect.stringMatching(/NEXT_REDIRECT.*\/s\/riverside/),
    });
  });

  test("user with no memberships sees the 'no schools yet' state", async () => {
    mockAuth(NO_SCHOOL_CLERK);

    const node = await HomePage();
    const html = await renderToString(node);
    expect(html).toContain("No schools yet");
    expect(html).toContain("noschool@example.com");
  });

  test("user with two memberships sees the picker with both schools", async () => {
    mockAuth(MULTI_CLERK);

    const node = await HomePage();
    const html = await renderToString(node);
    expect(html).toContain("Choose a school");
    expect(html).toContain("Riverside Swim School");
    expect(html).toContain("Coastal Swim School");
    // Picker links go to /s/<slug>.
    expect(html).toContain('href="/s/riverside"');
    expect(html).toContain('href="/s/coastal"');
  });
});

describe("/s/[schoolSlug] (requireTenant)", () => {
  test("user hits their own school: returns the resolved tenant", async () => {
    mockAuth(SOLO_CLERK);

    const ctx = await requireTenant("riverside");
    expect(ctx).toMatchObject({
      userId: SOLO_USER,
      schoolId: RIVERSIDE_ID,
      schoolName: "Riverside Swim School",
      role: "owner",
    });
  });

  test("user hits a school they don't belong to: 404 (collapsed from 403)", async () => {
    mockAuth(SOLO_CLERK);

    // notFound() throws an error tagged with NEXT_HTTP_ERROR_FALLBACK;404.
    await expect(requireTenant("coastal")).rejects.toMatchObject({
      digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404/),
    });
  });

  test("user hits a slug that doesn't exist: 404", async () => {
    mockAuth(SOLO_CLERK);

    await expect(requireTenant("nonexistent")).rejects.toMatchObject({
      digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404/),
    });
  });

  test("unauthenticated caller is redirected to /sign-in", async () => {
    mockAuth(null);

    await expect(requireTenant("riverside")).rejects.toMatchObject({
      digest: expect.stringMatching(/NEXT_REDIRECT.*\/sign-in/),
    });
  });

  test("mutation made under /s/[their-slug] populates created_by with the user's DB id", async () => {
    mockAuth(SOLO_CLERK);

    const ctx = await requireTenant("riverside");

    // Simulate what a server action under /s/[slug]/ would do: open a
    // tenant-scoped transaction and write a row. The audit-fields extension
    // should stamp `created_by` with the userId we threaded through.
    const newId = await withTenant(
      { schoolId: ctx.schoolId, userId: ctx.userId },
      async (tx) => {
        const loc = await tx.location.create({
          data: {
            schoolId: ctx.schoolId,
            name: "Pool 1",
          } as { schoolId: string; name: string; createdBy: string; updatedBy: string },
        });
        return loc.id;
      },
    );

    const row = await admin.location.findUnique({ where: { id: newId } });
    expect(row?.createdBy).toBe(SOLO_USER);
    expect(row?.updatedBy).toBe(SOLO_USER);
  });
});

// --- helpers --------------------------------------------------------------

// We render server-component output to a string for assertion.  This avoids
// pulling in a DOM; we only inspect text and href attributes.
async function renderToString(node: unknown): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  return renderToStaticMarkup(node as never);
}
