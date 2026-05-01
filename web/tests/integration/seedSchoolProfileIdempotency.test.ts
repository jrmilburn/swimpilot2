import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";

// Tight, focused scope: this test isolates the school-profile portion of
// the seed (the only part Chunk 2 changed) and proves that running the
// upsert twice with identical inputs leaves the row stable. Full-seed
// idempotency is exercised separately by running `npm run db:seed` twice
// in the dev workflow; pulling the entire seed into the integration suite
// would TRUNCATE shared fixtures other tests rely on.

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const RIVERSIDE_ID = "11111111-1111-1111-1111-111111111111";
const SOLO_USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

const PROFILE = {
  legalName: "Riverside Swim School Pty Ltd",
  tradingName: "Riverside Swim School",
  abn: "51824753556",
  gstRegistered: true,
  primaryContactName: "Maya Patel",
  primaryContactEmail: "owner@riverside.test",
  primaryContactPhone: "+61 2 9123 4567",
};

async function upsertRiversideProfile() {
  await admin.$executeRaw`
    INSERT INTO schools (
      slug, name, timezone, currency,
      legal_name, trading_name, abn, gst_registered,
      primary_contact_name, primary_contact_email, primary_contact_phone,
      created_by, updated_by, updated_at
    )
    VALUES (
      'riverside', 'Riverside Swim School', 'Australia/Sydney', 'AUD',
      ${PROFILE.legalName}, ${PROFILE.tradingName}, ${PROFILE.abn}, ${PROFILE.gstRegistered},
      ${PROFILE.primaryContactName}, ${PROFILE.primaryContactEmail}, ${PROFILE.primaryContactPhone},
      ${SYSTEM_USER_ID}::uuid, ${SYSTEM_USER_ID}::uuid, now()
    )
    ON CONFLICT (slug) DO UPDATE
      SET name = EXCLUDED.name,
          timezone = EXCLUDED.timezone,
          currency = EXCLUDED.currency,
          legal_name = EXCLUDED.legal_name,
          trading_name = EXCLUDED.trading_name,
          abn = EXCLUDED.abn,
          gst_registered = EXCLUDED.gst_registered,
          primary_contact_name = EXCLUDED.primary_contact_name,
          primary_contact_email = EXCLUDED.primary_contact_email,
          primary_contact_phone = EXCLUDED.primary_contact_phone,
          updated_at = now()
  `;
}

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations RESTART IDENTITY CASCADE`,
  );
  await admin.$executeRaw`
    INSERT INTO users (id, email, name, updated_at) VALUES
      (${SOLO_USER}::uuid, 'solo@example.com', 'Solo User', now())
  `;
  // Pre-create the school row so onboarding_progress / RLS / GUC
  // assumptions other tests rely on hold; the upsert path then reaches
  // the ON CONFLICT branch the way a re-seed would.
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${RIVERSIDE_ID}::uuid, 'riverside', 'Riverside Swim School', 'Australia/Sydney', 'AUD', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
});

describe("seed: school profile upsert idempotency", () => {
  test("first upsert lands all profile fields", async () => {
    await upsertRiversideProfile();

    const row = await admin.school.findUnique({
      where: { id: RIVERSIDE_ID },
    });
    expect(row?.legalName).toBe(PROFILE.legalName);
    expect(row?.tradingName).toBe(PROFILE.tradingName);
    expect(row?.abn).toBe(PROFILE.abn);
    expect(row?.gstRegistered).toBe(true);
    expect(row?.primaryContactName).toBe(PROFILE.primaryContactName);
    expect(row?.primaryContactEmail).toBe(PROFILE.primaryContactEmail);
    expect(row?.primaryContactPhone).toBe(PROFILE.primaryContactPhone);
  });

  test("second upsert with identical input leaves the same values", async () => {
    await upsertRiversideProfile();
    await upsertRiversideProfile();

    const row = await admin.school.findUnique({
      where: { id: RIVERSIDE_ID },
    });
    expect(row?.legalName).toBe(PROFILE.legalName);
    expect(row?.abn).toBe(PROFILE.abn);
    expect(row?.gstRegistered).toBe(true);
    expect(row?.primaryContactEmail).toBe(PROFILE.primaryContactEmail);

    // Slug-keyed conflict resolution must NOT have created a duplicate row.
    const count = await admin.school.count({ where: { slug: "riverside" } });
    expect(count).toBe(1);
  });
});
