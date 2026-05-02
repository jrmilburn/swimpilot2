import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { resolveAcceptedInvitation } from "../../src/lib/auth/resolveAcceptedInvitation";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const SCHOOL_B = "22222222-2222-2222-2222-222222222222";
const OWNER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const OWNER_B = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const NEW_USER = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const INV_A = "99999999-0000-0000-0000-00000000000a";
const INV_B = "99999999-0000-0000-0000-00000000000b";
const STALE_INV = "99999999-0000-0000-0000-00000000000c";
const LOCATION_A = "aaaaaaa0-0000-0000-0000-00000000000a";
const LEVEL_A = "eeeeeee0-0000-0000-0000-00000000000a";
const CLASS_A = "fffffff0-0000-0000-0000-00000000000a";

async function seed() {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations, class_levels, classes, pending_invitations RESTART IDENTITY CASCADE`,
  );
  await admin.$executeRaw`
    INSERT INTO users (id, email, name, updated_at) VALUES
      (${OWNER_A}::uuid, 'owner.a@example.com', 'Owner A', now()),
      (${OWNER_B}::uuid, 'owner.b@example.com', 'Owner B', now()),
      (${NEW_USER}::uuid, 'invitee@example.com', 'Invitee', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${SCHOOL_A}::uuid, 'school-a', 'School A', 'Australia/Sydney', 'AUD', ${OWNER_A}::uuid, ${OWNER_A}::uuid, now()),
      (${SCHOOL_B}::uuid, 'school-b', 'School B', 'Australia/Sydney', 'AUD', ${OWNER_B}::uuid, ${OWNER_B}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${OWNER_A}::uuid, 'owner', ${OWNER_A}::uuid, ${OWNER_A}::uuid, now()),
      (gen_random_uuid(), ${SCHOOL_B}::uuid, ${OWNER_B}::uuid, 'owner', ${OWNER_B}::uuid, ${OWNER_B}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO locations (id, school_id, name, created_by, updated_by, updated_at) VALUES
      (${LOCATION_A}::uuid, ${SCHOOL_A}::uuid, 'A Pool', ${OWNER_A}::uuid, ${OWNER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO class_levels (id, school_id, name, ratio, order_index, created_by, updated_by, updated_at) VALUES
      (${LEVEL_A}::uuid, ${SCHOOL_A}::uuid, 'A Infants', 4, 0, ${OWNER_A}::uuid, ${OWNER_A}::uuid, now())
  `;
}

async function resetInvitations() {
  await admin.$executeRawUnsafe(`DELETE FROM classes`);
  await admin.$executeRawUnsafe(`DELETE FROM pending_invitations`);
  // Clear memberships created by NEW_USER from prior tests; the seeded
  // owner rows for OWNER_A / OWNER_B are reinserted below.
  await admin.$executeRawUnsafe(`DELETE FROM memberships`);
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${OWNER_A}::uuid, 'owner', ${OWNER_A}::uuid, ${OWNER_A}::uuid, now()),
      (gen_random_uuid(), ${SCHOOL_B}::uuid, ${OWNER_B}::uuid, 'owner', ${OWNER_B}::uuid, ${OWNER_B}::uuid, now())
  `;
  // Two pending invitations across two schools, plus one stale (revoked)
  // invitation that resolveAcceptedInvitation must ignore.
  await admin.$executeRaw`
    INSERT INTO pending_invitations (
      id, school_id, email, role, clerk_invitation_id, invited_by_user_id,
      status, created_by, updated_by, updated_at
    ) VALUES
      (${INV_A}::uuid, ${SCHOOL_A}::uuid, 'invitee@example.com', 'teacher', NULL, ${OWNER_A}::uuid,
        'pending', ${OWNER_A}::uuid, ${OWNER_A}::uuid, now()),
      (${INV_B}::uuid, ${SCHOOL_B}::uuid, 'invitee@example.com', 'teacher', NULL, ${OWNER_B}::uuid,
        'pending', ${OWNER_B}::uuid, ${OWNER_B}::uuid, now()),
      (${STALE_INV}::uuid, ${SCHOOL_A}::uuid, 'invitee@example.com', 'teacher', NULL, ${OWNER_A}::uuid,
        'revoked', ${OWNER_A}::uuid, ${OWNER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO classes (
      id, school_id, location_id, level_id, pending_teacher_invitation_id,
      day_of_week, start_time, duration_minutes, capacity,
      created_by, updated_by, updated_at
    ) VALUES (
      ${CLASS_A}::uuid, ${SCHOOL_A}::uuid, ${LOCATION_A}::uuid, ${LEVEL_A}::uuid, ${INV_A}::uuid,
      'monday', '16:00:00', 30, 4,
      ${OWNER_A}::uuid, ${OWNER_A}::uuid, now()
    )
  `;
}

beforeAll(async () => {
  await seed();
});

beforeEach(async () => {
  await resetInvitations();
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("resolveAcceptedInvitation", () => {
  test("creates memberships across both schools, flips both invitations to accepted", async () => {
    const resolved = await resolveAcceptedInvitation(
      NEW_USER,
      "Invitee@example.com",
    );
    expect(resolved).toHaveLength(2);

    const memberships = await admin.membership.findMany({
      where: { userId: NEW_USER, deletedAt: null },
    });
    expect(memberships.map((m) => m.schoolId).sort()).toEqual(
      [SCHOOL_A, SCHOOL_B].sort(),
    );

    const invA = await admin.pendingInvitation.findUnique({
      where: { id: INV_A },
    });
    expect(invA?.status).toBe("accepted");
    expect(invA?.acceptedUserId).toBe(NEW_USER);
    expect(invA?.acceptedAt).toBeInstanceOf(Date);

    const invB = await admin.pendingInvitation.findUnique({
      where: { id: INV_B },
    });
    expect(invB?.status).toBe("accepted");

    const stale = await admin.pendingInvitation.findUnique({
      where: { id: STALE_INV },
    });
    expect(stale?.status).toBe("revoked");
    expect(stale?.acceptedUserId).toBeNull();
  });

  test("atomic swap: parked classes move from pending_teacher_invitation_id to teacher_id", async () => {
    await resolveAcceptedInvitation(NEW_USER, "invitee@example.com");

    const cls = await admin.class.findUnique({ where: { id: CLASS_A } });
    expect(cls?.teacherId).toBe(NEW_USER);
    expect(cls?.pendingTeacherInvitationId).toBeNull();
  });

  test("idempotent: second call finds nothing pending and no-ops", async () => {
    const first = await resolveAcceptedInvitation(NEW_USER, "invitee@example.com");
    expect(first).toHaveLength(2);

    const second = await resolveAcceptedInvitation(NEW_USER, "invitee@example.com");
    expect(second).toHaveLength(0);
  });

  test("re-activates soft-deleted membership, preserves existing role", async () => {
    // Pre-existing soft-deleted membership for NEW_USER on SCHOOL_A as 'manager'.
    // The invitation is for 'teacher'; re-activation must preserve the existing role.
    await admin.$executeRaw`
      INSERT INTO memberships (id, school_id, user_id, role, deleted_at, created_by, updated_by, updated_at) VALUES
        (gen_random_uuid(), ${SCHOOL_A}::uuid, ${NEW_USER}::uuid, 'manager', now(), ${OWNER_A}::uuid, ${OWNER_A}::uuid, now())
    `;

    await resolveAcceptedInvitation(NEW_USER, "invitee@example.com");

    const memberships = await admin.membership.findMany({
      where: { schoolId: SCHOOL_A, userId: NEW_USER },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.deletedAt).toBeNull();
    expect(memberships[0]?.role).toBe("manager"); // preserved, not overwritten to 'teacher'
  });

  test("unknown email returns empty array", async () => {
    const resolved = await resolveAcceptedInvitation(
      NEW_USER,
      "no-one@example.com",
    );
    expect(resolved).toHaveLength(0);
  });
});
