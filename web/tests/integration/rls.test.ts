import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "../../src/app/generated/prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const SCHOOL_B = "22222222-2222-2222-2222-222222222222";
const LOCATION_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const LOCATION_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";

beforeAll(async () => {
  // Truncate via admin (bypasses RLS as superuser). Each test run starts clean.
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations RESTART IDENTITY CASCADE`,
  );

  await admin.$executeRaw`
    INSERT INTO users (id, email, name, updated_at)
    VALUES (${USER_A}::uuid, 'a@example.com', 'User A', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, name, timezone, currency, created_by, updated_by, updated_at)
    VALUES
      (${SCHOOL_A}::uuid, 'School A', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${SCHOOL_B}::uuid, 'School B', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO locations (id, school_id, name, created_by, updated_by, updated_at)
    VALUES
      (${LOCATION_A}::uuid, ${SCHOOL_A}::uuid, 'Loc A', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${LOCATION_B}::uuid, ${SCHOOL_B}::uuid, 'Loc B', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at)
    VALUES (gen_random_uuid(), ${SCHOOL_A}::uuid, ${USER_A}::uuid, 'owner', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("RLS tenant isolation", () => {
  test("scoped to A, SELECT on locations returns only A's row", async () => {
    const rows = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => tx.location.findMany(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(LOCATION_A);
  });

  test("scoped to A, explicit WHERE school_id = B returns zero rows", async () => {
    const rows = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => tx.location.findMany({ where: { schoolId: SCHOOL_B } }),
    );
    expect(rows).toHaveLength(0);
  });

  test("scoped to A, INSERT with school_id = B fails (WITH CHECK violation)", async () => {
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        tx.location.create({
          // Audit fields are stamped by the auditExtension at runtime, but
          // TS can't see that, so we satisfy it explicitly here.
          data: {
            schoolId: SCHOOL_B,
            name: "cross-tenant",
            createdBy: USER_A,
            updatedBy: USER_A,
          },
        }),
      ),
    ).rejects.toThrow();

    // Confirm nothing was actually inserted.
    const all = await admin.location.findMany();
    expect(all.map((l) => l.id).sort()).toEqual(
      [LOCATION_A, LOCATION_B].sort(),
    );
  });

  test("scoped to A, UPDATE on B's location affects zero rows", async () => {
    const result = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        tx.location.updateMany({
          where: { id: LOCATION_B },
          data: { name: "tampered" },
        }),
    );
    expect(result.count).toBe(0);

    const b = await admin.location.findUnique({ where: { id: LOCATION_B } });
    expect(b?.name).toBe("Loc B");
  });

  test("with no app.school_id set, queries on tenant tables return zero rows", async () => {
    // Note: we deliberately go through the regular client (not withTenant),
    // so no `set_config` runs. RLS evaluates `school_id = NULL::uuid`, which
    // is NULL, so every row is filtered out.
    const locations = await prisma.location.findMany();
    expect(locations).toHaveLength(0);

    const schools = await prisma.school.findMany();
    expect(schools).toHaveLength(0);

    const memberships = await prisma.membership.findMany();
    expect(memberships).toHaveLength(0);
  });
});
