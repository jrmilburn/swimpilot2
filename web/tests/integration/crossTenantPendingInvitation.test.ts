import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as pendingInvitationRepository from "../../src/repositories/pendingInvitationRepository";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const SCHOOL_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const USER_B = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const INV_B = "99999999-0000-0000-0000-00000000000b";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, pending_invitations RESTART IDENTITY CASCADE`,
  );
  await admin.$executeRaw`
    INSERT INTO users (id, email, name, updated_at) VALUES
      (${USER_A}::uuid, 'a@example.com', 'A', now()),
      (${USER_B}::uuid, 'b@example.com', 'B', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${SCHOOL_A}::uuid, 'school-a', 'School A', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${SCHOOL_B}::uuid, 'school-b', 'School B', 'Australia/Sydney', 'AUD', ${USER_B}::uuid, ${USER_B}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${USER_A}::uuid, 'owner', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (gen_random_uuid(), ${SCHOOL_B}::uuid, ${USER_B}::uuid, 'owner', ${USER_B}::uuid, ${USER_B}::uuid, now())
  `;
  // Pending invitation seeded into School B.
  await admin.$executeRaw`
    INSERT INTO pending_invitations (
      id, school_id, email, role, clerk_invitation_id, invited_by_user_id,
      status, created_by, updated_by, updated_at
    ) VALUES (
      ${INV_B}::uuid, ${SCHOOL_B}::uuid, 'shared@example.com', 'teacher', NULL, ${USER_B}::uuid,
      'pending', ${USER_B}::uuid, ${USER_B}::uuid, now()
    )
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("pending_invitations: cross-tenant isolation under RLS", () => {
  test("scoped to A: getById of B's invitation returns null", async () => {
    const found = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => pendingInvitationRepository.getById(tx, INV_B),
    );
    expect(found).toBeNull();
  });

  test("scoped to A: listBySchool returns no row from B", async () => {
    const rows = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => pendingInvitationRepository.listBySchool(tx),
    );
    expect(rows.find((r) => r.id === INV_B)).toBeUndefined();
    expect(rows.every((r) => r.schoolId === SCHOOL_A)).toBe(true);
  });

  test("scoped to A: getPendingByEmail with B's invitee email returns null", async () => {
    const found = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        pendingInvitationRepository.getPendingByEmail(tx, "shared@example.com"),
    );
    expect(found).toBeNull();
  });

  test("no tenant context: listBySchool sees nothing (fail closed)", async () => {
    const rows = await pendingInvitationRepository.listBySchool(prisma);
    expect(rows).toHaveLength(0);
  });

  test("scoped to A: WITH CHECK blocks insert with school_id=B", async () => {
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        tx.$executeRaw`
          INSERT INTO pending_invitations (
            id, school_id, email, role, invited_by_user_id,
            status, created_by, updated_by, updated_at
          ) VALUES (
            gen_random_uuid(), ${SCHOOL_B}::uuid, 'attempted@example.com', 'teacher', ${USER_A}::uuid,
            'pending', ${USER_A}::uuid, ${USER_A}::uuid, now()
          )
        `,
      ),
    ).rejects.toThrow();
  });
});
