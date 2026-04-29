/**
 * Seed two reference schools used in development and the integration suite.
 *
 * Idempotent: re-running this should leave the same two slugs in place. Run
 * via `npx tsx prisma/seed.ts` (or `node --import tsx`) using ADMIN_DATABASE_URL.
 *
 * Note: tenant tables are RLS-scoped, but seeds run as the migration / admin
 * role which has BYPASSRLS-equivalent ownership in practice. That's fine —
 * seeds are not user-facing code paths.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

const SEED_SCHOOLS = [
  {
    slug: "riverside",
    name: "Riverside Swim School",
    timezone: "Australia/Sydney",
    currency: "AUD",
  },
  {
    slug: "coastal",
    name: "Coastal Swim School",
    timezone: "Australia/Sydney",
    currency: "AUD",
  },
];

async function main() {
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url) {
    throw new Error("seed: ADMIN_DATABASE_URL is required");
  }

  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    for (const s of SEED_SCHOOLS) {
      await prisma.$executeRaw`
        INSERT INTO schools (slug, name, timezone, currency, created_by, updated_by, updated_at)
        VALUES (${s.slug}, ${s.name}, ${s.timezone}, ${s.currency},
                ${SYSTEM_USER_ID}::uuid, ${SYSTEM_USER_ID}::uuid, now())
        ON CONFLICT (slug) DO UPDATE
          SET name = EXCLUDED.name,
              timezone = EXCLUDED.timezone,
              currency = EXCLUDED.currency,
              updated_at = now()
      `;
    }
    const rows = await prisma.school.findMany({
      where: { slug: { in: SEED_SCHOOLS.map((s) => s.slug) } },
      select: { slug: true, name: true },
    });
    console.log("Seeded schools:", rows);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
