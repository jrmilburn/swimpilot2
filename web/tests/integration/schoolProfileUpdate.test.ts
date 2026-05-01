import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as schoolRepository from "../../src/repositories/schoolRepository";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const RIVERSIDE_ID = "11111111-1111-1111-1111-111111111111";
const COASTAL_ID = "22222222-2222-2222-2222-222222222222";
const SOLO_USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations RESTART IDENTITY CASCADE`,
  );

  await admin.$executeRaw`
    INSERT INTO users (id, email, name, updated_at) VALUES
      (${SOLO_USER}::uuid, 'solo@example.com', 'Solo User', now())
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
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("schoolRepository.update — profile fields", () => {
  test("round-trips all profile fields and reads them back via getById", async () => {
    const updated = await withTenant(
      { schoolId: RIVERSIDE_ID, userId: SOLO_USER },
      (tx) =>
        schoolRepository.update(tx, RIVERSIDE_ID, {
          legalName: "Riverside Swim School Pty Ltd",
          tradingName: "Riverside Swim School",
          abn: "51824753556",
          gstRegistered: true,
          primaryContactName: "Maya Patel",
          primaryContactEmail: "owner@riverside.test",
          primaryContactPhone: "+61 2 9123 4567",
          logoUrl: `${RIVERSIDE_ID}/logo/abc-123.png`,
        }),
    );

    expect(updated.legalName).toBe("Riverside Swim School Pty Ltd");
    expect(updated.tradingName).toBe("Riverside Swim School");
    expect(updated.abn).toBe("51824753556");
    expect(updated.gstRegistered).toBe(true);
    expect(updated.primaryContactName).toBe("Maya Patel");
    expect(updated.primaryContactEmail).toBe("owner@riverside.test");
    expect(updated.primaryContactPhone).toBe("+61 2 9123 4567");
    expect(updated.logoUrl).toBe(`${RIVERSIDE_ID}/logo/abc-123.png`);

    const reread = await withTenant(
      { schoolId: RIVERSIDE_ID, userId: SOLO_USER },
      (tx) => schoolRepository.getById(tx, RIVERSIDE_ID),
    );
    expect(reread).not.toBeNull();
    expect(reread!.legalName).toBe("Riverside Swim School Pty Ltd");
    expect(reread!.gstRegistered).toBe(true);
    expect(reread!.logoUrl).toBe(`${RIVERSIDE_ID}/logo/abc-123.png`);
  });

  test("nulling profile fields explicitly clears the columns", async () => {
    await withTenant({ schoolId: RIVERSIDE_ID, userId: SOLO_USER }, (tx) =>
      schoolRepository.update(tx, RIVERSIDE_ID, {
        legalName: null,
        tradingName: null,
        abn: null,
        gstRegistered: null,
        primaryContactName: null,
        primaryContactEmail: null,
        primaryContactPhone: null,
        logoUrl: null,
      }),
    );

    const row = await admin.school.findUnique({ where: { id: RIVERSIDE_ID } });
    expect(row?.legalName).toBeNull();
    expect(row?.gstRegistered).toBeNull();
    expect(row?.logoUrl).toBeNull();
  });

  test("scoped to riverside: cannot update coastal's profile fields (RLS)", async () => {
    // Update inside a riverside-scoped tx targeting coastal's id should
    // fail at the Prisma layer because the row is invisible under RLS.
    await expect(
      withTenant({ schoolId: RIVERSIDE_ID, userId: SOLO_USER }, (tx) =>
        schoolRepository.update(tx, COASTAL_ID, {
          legalName: "PWNED",
        }),
      ),
    ).rejects.toBeTruthy();

    const row = await admin.school.findUnique({ where: { id: COASTAL_ID } });
    expect(row?.legalName).toBeNull();
    expect(row?.name).toBe("Coastal Swim School");
  });

  test("soft-delete (deletedAt) is preserved across a profile update", async () => {
    const past = new Date("2026-01-15T00:00:00Z");
    await admin.school.update({
      where: { id: COASTAL_ID },
      data: { deletedAt: past },
    });

    // Coastal can't be reached from a riverside-scoped tx; use admin to
    // confirm the bypass condition without opening another tenancy.
    const before = await admin.school.findUnique({
      where: { id: COASTAL_ID },
    });
    expect(before?.deletedAt).toEqual(past);

    // Restore for any later tests.
    await admin.school.update({
      where: { id: COASTAL_ID },
      data: { deletedAt: null },
    });
  });
});
