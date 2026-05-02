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
import { assignTeacherToClass } from "../../src/app/s/[schoolSlug]/onboarding/teachers/_actions/assignTeacherToClass";
import { unassignTeacherFromClass } from "../../src/app/s/[schoolSlug]/onboarding/teachers/_actions/unassignTeacherFromClass";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const RIVERSIDE_ID = "11111111-1111-1111-1111-111111111111";
const SOLO_USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SOLO_CLERK = "user_solo_test";
const TEACHER_A = "dddddddd-dddd-4ddd-8ddd-00000000000a";
const TEACHER_B = "dddddddd-dddd-4ddd-8ddd-00000000000b";
const LOCATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-00000000000a";
const LEVEL_ID = "eeeeeeee-eeee-4eee-8eee-00000000000a";
const CLASS_ID = "ffffffff-ffff-4fff-8fff-00000000000a";
const INVITATION_ID = "99999999-9999-4999-8999-000000000001";

async function seed() {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations, class_levels, classes, pending_invitations RESTART IDENTITY CASCADE`,
  );
  await admin.$executeRaw`
    INSERT INTO users (id, clerk_id, email, name, updated_at) VALUES
      (${SOLO_USER}::uuid, ${SOLO_CLERK}, 'solo@example.com', 'Solo', now()),
      (${TEACHER_A}::uuid, NULL, 'teacher.a@example.com', 'Teacher A', now()),
      (${TEACHER_B}::uuid, NULL, 'teacher.b@example.com', 'Teacher B', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${RIVERSIDE_ID}::uuid, 'riverside', 'Riverside', 'Australia/Sydney', 'AUD', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${RIVERSIDE_ID}::uuid, ${SOLO_USER}::uuid, 'owner', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now()),
      (gen_random_uuid(), ${RIVERSIDE_ID}::uuid, ${TEACHER_A}::uuid, 'teacher', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now()),
      (gen_random_uuid(), ${RIVERSIDE_ID}::uuid, ${TEACHER_B}::uuid, 'teacher', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO locations (id, school_id, name, created_by, updated_by, updated_at) VALUES
      (${LOCATION_ID}::uuid, ${RIVERSIDE_ID}::uuid, 'Pool 1', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO class_levels (id, school_id, name, ratio, order_index, created_by, updated_by, updated_at) VALUES
      (${LEVEL_ID}::uuid, ${RIVERSIDE_ID}::uuid, 'Infants', 4, 0, ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
}

async function resetClass() {
  await admin.$executeRawUnsafe(`DELETE FROM classes`);
  await admin.$executeRaw`
    INSERT INTO classes (
      id, school_id, location_id, level_id,
      day_of_week, start_time, duration_minutes, capacity,
      created_by, updated_by, updated_at
    ) VALUES (
      ${CLASS_ID}::uuid, ${RIVERSIDE_ID}::uuid, ${LOCATION_ID}::uuid, ${LEVEL_ID}::uuid,
      'monday', '16:00:00', 30, 4,
      ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now()
    )
  `;
}

async function resetInvitation() {
  await admin.$executeRawUnsafe(`DELETE FROM pending_invitations`);
  await admin.$executeRaw`
    INSERT INTO pending_invitations (
      id, school_id, email, role, clerk_invitation_id, invited_by_user_id,
      status, created_by, updated_by, updated_at
    ) VALUES (
      ${INVITATION_ID}::uuid, ${RIVERSIDE_ID}::uuid, 'invitee@example.com', 'teacher', 'inv_clerk_xx', ${SOLO_USER}::uuid,
      'pending', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now()
    )
  `;
}

beforeAll(async () => {
  await seed();
});

beforeEach(async () => {
  vi.mocked(auth).mockReset();
  headerStore.current = new Headers();
  await resetClass();
  await resetInvitation();
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

describe("assignTeacherToClass", () => {
  test("teacher assignment sets teacher_id and clears pending in one update", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await assignTeacherToClass({
      classId: CLASS_ID,
      assignment: { kind: "teacher", teacherId: TEACHER_A },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.teacherId).toBe(TEACHER_A);
    expect(result.data.pendingTeacherInvitationId).toBeNull();
  });

  test("pending assignment sets pending_teacher_invitation_id and clears teacher", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await assignTeacherToClass({
      classId: CLASS_ID,
      assignment: { kind: "pending", invitationId: INVITATION_ID },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.teacherId).toBeNull();
    expect(result.data.pendingTeacherInvitationId).toBe(INVITATION_ID);
  });

  test("atomic swap: teacher → pending in single UPDATE never violates XOR check", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const first = await assignTeacherToClass({
      classId: CLASS_ID,
      assignment: { kind: "teacher", teacherId: TEACHER_A },
    });
    expect(first.ok).toBe(true);

    const second = await assignTeacherToClass({
      classId: CLASS_ID,
      assignment: { kind: "pending", invitationId: INVITATION_ID },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.teacherId).toBeNull();
    expect(second.data.pendingTeacherInvitationId).toBe(INVITATION_ID);

    const swapBack = await assignTeacherToClass({
      classId: CLASS_ID,
      assignment: { kind: "teacher", teacherId: TEACHER_B },
    });
    expect(swapBack.ok).toBe(true);
    if (!swapBack.ok) return;
    expect(swapBack.data.teacherId).toBe(TEACHER_B);
    expect(swapBack.data.pendingTeacherInvitationId).toBeNull();
  });

  test("unassign clears both columns", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    await assignTeacherToClass({
      classId: CLASS_ID,
      assignment: { kind: "teacher", teacherId: TEACHER_A },
    });

    const result = await unassignTeacherFromClass({ classId: CLASS_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.teacherId).toBeNull();
    expect(result.data.pendingTeacherInvitationId).toBeNull();
  });

  test("non-pending invitation rejects with VALIDATION", async () => {
    await admin.$executeRaw`
      UPDATE pending_invitations SET status = 'revoked' WHERE id = ${INVITATION_ID}::uuid
    `;
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const result = await assignTeacherToClass({
      classId: CLASS_ID,
      assignment: { kind: "pending", invitationId: INVITATION_ID },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });
});
