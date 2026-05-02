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

const createInvitation = vi.fn();
const revokeInvitation = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
  clerkClient: vi.fn(async () => ({
    invitations: {
      createInvitation,
      revokeInvitation,
    },
  })),
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
import { Role } from "../../src/domain/enums";
import { inviteTeacher } from "../../src/app/s/[schoolSlug]/onboarding/teachers/_actions/inviteTeacher";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const RIVERSIDE_ID = "11111111-1111-1111-1111-111111111111";
const SOLO_USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SOLO_CLERK = "user_solo_test";

async function seed() {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, pending_invitations RESTART IDENTITY CASCADE`,
  );
  await admin.$executeRaw`
    INSERT INTO users (id, clerk_id, email, name, updated_at) VALUES
      (${SOLO_USER}::uuid, ${SOLO_CLERK}, 'solo@example.com', 'Solo', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${RIVERSIDE_ID}::uuid, 'riverside', 'Riverside', 'Australia/Sydney', 'AUD', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
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
  createInvitation.mockReset();
  revokeInvitation.mockReset();
  headerStore.current = new Headers();
  await admin.$executeRawUnsafe(`DELETE FROM pending_invitations`);
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

describe("inviteTeacher", () => {
  test("happy path: Clerk invitation created, DB row persisted with clerk id", async () => {
    createInvitation.mockResolvedValueOnce({ id: "inv_clerk_123" });

    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await inviteTeacher({ email: "Alice@Example.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.email).toBe("alice@example.com");
    expect(result.data.role).toBe(Role.Teacher);
    expect(result.data.clerkInvitationId).toBe("inv_clerk_123");
    expect(result.data.status).toBe("pending");

    expect(createInvitation).toHaveBeenCalledOnce();
    const arg = createInvitation.mock.calls[0]![0];
    expect(arg.emailAddress).toBe("alice@example.com");

    const rows = await admin.pendingInvitation.findMany({
      where: { schoolId: RIVERSIDE_ID },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe("alice@example.com");
    expect(rows[0]?.clerkInvitationId).toBe("inv_clerk_123");
  });

  test("duplicate pre-check: second invite for same email rejects with VALIDATION (no Clerk call)", async () => {
    createInvitation.mockResolvedValueOnce({ id: "inv_clerk_first" });
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const first = await inviteTeacher({ email: "alice@example.com" });
    expect(first.ok).toBe(true);
    expect(createInvitation).toHaveBeenCalledOnce();

    const second = await inviteTeacher({ email: "ALICE@example.com" });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("VALIDATION");
    expect(second.error.fieldErrors?.email).toMatch(/already pending/i);

    expect(createInvitation).toHaveBeenCalledOnce(); // not called again
  });

  test("Clerk failure surfaces VALIDATION error and leaves no DB row", async () => {
    createInvitation.mockRejectedValueOnce(new Error("Clerk down"));
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await inviteTeacher({ email: "bob@example.com" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.fieldErrors?._form).toMatch(/Could not send/);

    const rows = await admin.pendingInvitation.findMany({
      where: { email: "bob@example.com" },
    });
    expect(rows).toHaveLength(0);
  });

  test("invalid email rejects with field error before any Clerk call", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await inviteTeacher({ email: "not-an-email" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.fieldErrors?.email).toBeDefined();
    expect(createInvitation).not.toHaveBeenCalled();
  });
});
