import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";

// The AFTER INSERT trigger on `schools` is the only path that creates
// `onboarding_progress` rows; the / landing page and the wizard layout both
// assume one row exists per school. These tests pin that contract:
//   1. Inserting a fresh school via SQL produces exactly one row, with the
//      expected defaults.
//   2. The seed schools (Riverside, Coastal) are backfilled as already-
//      completed (every existing test that exercises the / landing redirect
//      assumes those schools land on the dashboard, not the wizard).

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SEED_USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const RIVERSIDE_ID = "11111111-1111-1111-1111-111111111111";
const COASTAL_ID = "22222222-2222-2222-2222-222222222222";
const FRESH_SCHOOL_ID = "33333333-3333-3333-3333-333333333333";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations RESTART IDENTITY CASCADE`,
  );
  await admin.$executeRaw`
    INSERT INTO users (id, email, name, updated_at) VALUES
      (${SEED_USER}::uuid, 'seed@example.com', 'Seed User', now())
  `;
  // Re-seed Riverside + Coastal exactly the way the migration's backfill
  // expects to find them. Inserting these triggers the AFTER INSERT path,
  // which materialises an onboarding_progress row with `not_started`
  // defaults; the backfill step is what flips them to `completed`. To
  // exercise both halves of the migration's contract we run the same
  // backfill statement here so this test mirrors what `prisma migrate
  // deploy` did against a non-empty database.
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${RIVERSIDE_ID}::uuid, 'riverside', 'Riverside Swim School', 'Australia/Sydney', 'AUD', ${SEED_USER}::uuid, ${SEED_USER}::uuid, now()),
      (${COASTAL_ID}::uuid,   'coastal',   'Coastal Swim School',   'Australia/Sydney', 'AUD', ${SEED_USER}::uuid, ${SEED_USER}::uuid, now())
  `;
  // Mirror the migration backfill: existing schools at deploy time ended up
  // marked completed. Idempotent via ON CONFLICT.
  await admin.$executeRawUnsafe(`
    INSERT INTO onboarding_progress (
      school_id, current_step, step_statuses, last_activity_at, completed_at,
      created_by, updated_by, updated_at
    )
    SELECT
      s.id,
      'done'::onboarding_step,
      jsonb_build_object(
        'profile','completed','locations','completed','levels','completed',
        'skills','completed','classes','completed','teachers','completed',
        'billing','completed','channels','completed','import','completed'
      ),
      now(), now(), s.created_by, s.updated_by, now()
    FROM schools s
    WHERE s.deleted_at IS NULL
    ON CONFLICT (school_id) DO UPDATE
      SET current_step = EXCLUDED.current_step,
          step_statuses = EXCLUDED.step_statuses,
          completed_at = EXCLUDED.completed_at,
          updated_at = now();
  `);
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("AFTER INSERT trigger on schools", () => {
  test("inserting a school materialises exactly one onboarding_progress row with expected defaults", async () => {
    await admin.$executeRaw`
      INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
        (${FRESH_SCHOOL_ID}::uuid, 'fresh', 'Fresh Swim School', 'Australia/Sydney', 'AUD', ${SEED_USER}::uuid, ${SEED_USER}::uuid, now())
    `;

    const rows = await admin.$queryRaw<
      Array<{
        school_id: string;
        current_step: string;
        step_statuses: Record<string, string>;
        completed_at: Date | null;
        created_by: string;
        updated_by: string;
      }>
    >`
      SELECT school_id, current_step, step_statuses, completed_at, created_by, updated_by
      FROM onboarding_progress
      WHERE school_id = ${FRESH_SCHOOL_ID}::uuid
    `;

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.current_step).toBe("profile");
    expect(row.completed_at).toBeNull();
    expect(row.created_by).toBe(SEED_USER);
    expect(row.updated_by).toBe(SEED_USER);
    expect(row.step_statuses).toEqual({
      profile: "not_started",
      locations: "not_started",
      levels: "not_started",
      skills: "not_started",
      classes: "not_started",
      teachers: "not_started",
      billing: "not_started",
      channels: "not_started",
      import: "not_started",
    });
  });

  test("backfill: Riverside + Coastal land with completed_at set and current_step = done", async () => {
    const rows = await admin.$queryRaw<
      Array<{
        school_id: string;
        current_step: string;
        completed_at: Date | null;
      }>
    >`
      SELECT school_id, current_step, completed_at
      FROM onboarding_progress
      WHERE school_id IN (${RIVERSIDE_ID}::uuid, ${COASTAL_ID}::uuid)
      ORDER BY school_id
    `;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.current_step).toBe("done");
      expect(row.completed_at).toBeInstanceOf(Date);
    }
  });

  test("re-inserting the same school id is blocked by PK; ON CONFLICT in the trigger means no second progress row", async () => {
    // Inserting a duplicate school is rejected by the schools PK — the
    // trigger never fires a second time. Sanity-check that there's still
    // exactly one progress row for FRESH_SCHOOL_ID.
    await expect(
      admin.$executeRaw`
        INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
          (${FRESH_SCHOOL_ID}::uuid, 'fresh-dup', 'Dup', 'Australia/Sydney', 'AUD', ${SEED_USER}::uuid, ${SEED_USER}::uuid, now())
      `,
    ).rejects.toThrow();

    const count = await admin.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n FROM onboarding_progress WHERE school_id = ${FRESH_SCHOOL_ID}::uuid
    `;
    expect(Number(count[0]!.n)).toBe(1);
  });
});
