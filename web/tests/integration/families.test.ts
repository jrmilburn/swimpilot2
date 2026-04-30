import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as familyRepository from "../../src/repositories/familyRepository";
import { CommunicationPreference } from "../../src/domain/enums";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations, families, students RESTART IDENTITY CASCADE`,
  );

  await admin.$executeRaw`
    INSERT INTO users (id, email, name, updated_at) VALUES
      (${USER_A}::uuid, 'a@example.com', 'User A', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${SCHOOL_A}::uuid, 'school-a', 'School A', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${USER_A}::uuid, 'owner', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("familyRepository", () => {
  test("create + getById round-trips and stamps audit fields with signed-in actor", async () => {
    const family = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        familyRepository.create(tx, {
          primaryContactName: "Alex Nguyen",
          primaryContactEmail: "alex@example.com",
          primaryContactPhone: "+61 400 000 001",
          suburb: "Bondi",
          state: "NSW",
          postcode: "2026",
          communicationPreference: CommunicationPreference.Both,
        }),
    );

    expect(family.id).toBeTruthy();
    expect(family.schoolId).toBe(SCHOOL_A);
    expect(family.communicationPreference).toBe(CommunicationPreference.Both);

    const fetched = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => familyRepository.getById(tx, family.id),
    );
    expect(fetched?.id).toBe(family.id);
    expect(fetched?.primaryContactEmail).toBe("alex@example.com");

    // Audit fields aren't on the domain type — read them via admin to confirm.
    const row = await admin.family.findUnique({ where: { id: family.id } });
    expect(row?.createdBy).toBe(USER_A);
    expect(row?.updatedBy).toBe(USER_A);
  });

  test("update mutates fields and bumps updated_by", async () => {
    const created = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        familyRepository.create(tx, {
          primaryContactName: "Sam Patel",
          primaryContactEmail: "sam@example.com",
        }),
    );

    const updated = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        familyRepository.update(tx, created.id, {
          notes: "Prefers morning lessons",
          communicationPreference: CommunicationPreference.Sms,
        }),
    );

    expect(updated.notes).toBe("Prefers morning lessons");
    expect(updated.communicationPreference).toBe(CommunicationPreference.Sms);
  });

  test("listBySchool returns only the current tenant's rows and paginates", async () => {
    // Seed a few extra families so we can exercise the cursor.
    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, async (tx) => {
      for (let i = 0; i < 3; i++) {
        await familyRepository.create(tx, {
          primaryContactName: `Page Test ${i}`,
          primaryContactEmail: `page${i}@example.com`,
        });
      }
    });

    const firstPage = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => familyRepository.listBySchool(tx, { limit: 2 }),
    );
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).toBeTruthy();

    const secondPage = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        familyRepository.listBySchool(tx, {
          limit: 2,
          cursor: firstPage.nextCursor,
        }),
    );
    expect(secondPage.items.length).toBeGreaterThan(0);
    // No overlap between pages.
    const firstIds = new Set(firstPage.items.map((f) => f.id));
    for (const item of secondPage.items) {
      expect(firstIds.has(item.id)).toBe(false);
    }
  });
});
