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

// Server actions normally read the slug from `next/headers`. In tests we
// stub `headers()` to return a Headers instance we control per-test.
const headerStore: { current: Headers } = { current: new Headers() };
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => headerStore.current),
}));

import { auth } from "@clerk/nextjs/server";
import { prisma } from "../../src/lib/db/client";
import { tenantAction } from "../../src/lib/auth/tenantAction";
import { ValidationError } from "../../src/lib/errors";
import * as schoolRepository from "../../src/repositories/schoolRepository";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const RIVERSIDE_ID = "11111111-1111-1111-1111-111111111111";
const COASTAL_ID = "22222222-2222-2222-2222-222222222222";
const SOLO_USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const NO_SCHOOL_USER = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const SOLO_CLERK = "user_solo_test";
const NO_SCHOOL_CLERK = "user_noschool_test";

async function seed() {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations RESTART IDENTITY CASCADE`,
  );
  await admin.$executeRaw`
    INSERT INTO users (id, clerk_id, email, name, updated_at) VALUES
      (${SOLO_USER}::uuid,      ${SOLO_CLERK},      'solo@example.com',     'Solo User', now()),
      (${NO_SCHOOL_USER}::uuid, ${NO_SCHOOL_CLERK}, 'noschool@example.com', 'No School', now())
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
}

beforeAll(async () => {
  await seed();
});

beforeEach(() => {
  vi.mocked(auth).mockReset();
  headerStore.current = new Headers();
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

describe("tenantAction()", () => {
  test("member: action runs, mutation succeeds, audit fields reflect the user", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const renameSchool = tenantAction(
      async ({ tx, schoolId }, input: { name: string }) => {
        return schoolRepository.update(tx, schoolId, { name: input.name });
      },
    );

    const result = await renameSchool({ name: "Riverside Renamed" });

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({ name: "Riverside Renamed" }),
    });

    const row = await admin.school.findUnique({ where: { id: RIVERSIDE_ID } });
    expect(row?.name).toBe("Riverside Renamed");
    expect(row?.updatedBy).toBe(SOLO_USER);
  });

  test("non-member of slug: 404 (collapsed from forbidden) — redirect/notFound propagates", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("coastal"); // SOLO_USER has no membership in coastal

    const noop = tenantAction(async () => "should not run");

    // requireTenant() collapses no-membership to notFound() (per security
    // rationale in docs/security.md). notFound() throws a Next control-flow
    // error which `unstable_rethrow` must let bubble out — never an
    // ActionResult.
    await expect(noop()).rejects.toMatchObject({
      digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404/),
    });
  });

  test("unauthenticated: redirect to /sign-in propagates (not swallowed)", async () => {
    mockAuth(null);
    setSlug("riverside");

    const noop = tenantAction(async () => "should not run");

    await expect(noop()).rejects.toMatchObject({
      digest: expect.stringMatching(/NEXT_REDIRECT.*\/sign-in/),
    });
  });

  test("ValidationError: maps to { code: 'VALIDATION', message }", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const action = tenantAction(async () => {
      throw new ValidationError("name too short");
    });

    const result = await action();
    expect(result).toEqual({
      ok: false,
      error: { code: "VALIDATION", message: "name too short" },
    });
  });

  test("unexpected Error: maps to INTERNAL with generic message; original logged, never leaked", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const action = tenantAction(async () => {
      throw new Error("internal SQL detail: column users.password");
    });

    const result = await action();

    expect(result).toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "Something went wrong" },
    });
    // Original message must NOT be present in the result returned to client.
    expect(JSON.stringify(result)).not.toContain("password");
    // …but it must have been logged server-side.
    expect(errorSpy).toHaveBeenCalled();
    const loggedArgs = errorSpy.mock.calls.flat();
    expect(loggedArgs.some((a) => String(a).includes("password") || (a instanceof Error && a.message.includes("password")))).toBe(true);

    errorSpy.mockRestore();
  });

  test("RLS sanity: an action scoped to riverside cannot write to coastal via tx", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    // Belt-and-braces: prove the tx in the action's context is actually
    // tenant-scoped. Updating COASTAL_ID from a riverside-scoped tx must
    // fail (RLS rejects: row not visible / not writable).
    const evil = tenantAction(async ({ tx }) => {
      return schoolRepository.update(tx, COASTAL_ID, { name: "PWNED" });
    });

    const result = await evil();

    // Prisma's update on a row not visible to the current RLS scope throws
    // a record-not-found-style error. tenantAction maps unknown throws to
    // INTERNAL.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
    }

    // And the row really wasn't mutated.
    const row = await admin.school.findUnique({ where: { id: COASTAL_ID } });
    expect(row?.name).toBe("Coastal Swim School");
  });
});
