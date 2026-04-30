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

describe("schoolRepository.getById under RLS", () => {
  test("scoped to riverside: returns the riverside school", async () => {
    const school = await withTenant(
      { schoolId: RIVERSIDE_ID, userId: SOLO_USER },
      (tx) => schoolRepository.getById(tx, RIVERSIDE_ID),
    );
    expect(school).not.toBeNull();
    expect(school?.id).toBe(RIVERSIDE_ID);
    expect(school?.slug).toBe("riverside");
  });

  test("scoped to riverside: getById(coastal) is null (RLS filters)", async () => {
    const school = await withTenant(
      { schoolId: RIVERSIDE_ID, userId: SOLO_USER },
      (tx) => schoolRepository.getById(tx, COASTAL_ID),
    );
    expect(school).toBeNull();
  });

  test("no tenant context: getById is null (fail closed)", async () => {
    const school = await schoolRepository.getById(prisma, RIVERSIDE_ID);
    expect(school).toBeNull();
  });
});
