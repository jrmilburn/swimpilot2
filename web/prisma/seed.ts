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

type StudentSeed = {
  firstName: string;
  lastName: string;
  // Plausible swim school ages: 6 months – 14 years. We compute the DOB from
  // an age-in-years offset against today so seed runs always produce
  // age-appropriate data without us having to update fixtures.
  ageYears: number;
  status?: "active" | "paused" | "withdrawn";
};

type FamilySeed = {
  primaryContactName: string;
  primaryContactEmail: string;
  primaryContactPhone?: string;
  suburb?: string;
  state?: string;
  postcode?: string;
  communicationPreference?: "email" | "sms" | "both";
  notes?: string;
  students: StudentSeed[];
};

const RIVERSIDE_FAMILIES: FamilySeed[] = [
  {
    primaryContactName: "Hannah Nguyen",
    primaryContactEmail: "hannah.nguyen@example.com",
    primaryContactPhone: "+61 412 345 678",
    suburb: "Parramatta",
    state: "NSW",
    postcode: "2150",
    communicationPreference: "both",
    students: [
      { firstName: "Mia", lastName: "Nguyen", ageYears: 7 },
      { firstName: "Leo", lastName: "Nguyen", ageYears: 5 },
    ],
  },
  {
    primaryContactName: "James O'Connor",
    primaryContactEmail: "james.oconnor@example.com",
    primaryContactPhone: "+61 423 654 987",
    suburb: "Ryde",
    state: "NSW",
    postcode: "2112",
    students: [
      { firstName: "Charlotte", lastName: "O'Connor", ageYears: 9, status: "paused" },
    ],
  },
  {
    primaryContactName: "Priya Patel",
    primaryContactEmail: "priya.patel@example.com",
    primaryContactPhone: "+61 401 222 333",
    suburb: "Carlingford",
    state: "NSW",
    postcode: "2118",
    communicationPreference: "sms",
    notes: "Prefers afternoon lessons; younger child has eczema.",
    students: [
      { firstName: "Aarav", lastName: "Patel", ageYears: 11 },
      { firstName: "Ishani", lastName: "Patel", ageYears: 8 },
      { firstName: "Vihaan", lastName: "Patel", ageYears: 4 },
    ],
  },
  {
    primaryContactName: "Sarah Wilson",
    primaryContactEmail: "sarah.wilson@example.com",
    suburb: "Epping",
    state: "NSW",
    postcode: "2121",
    students: [
      { firstName: "Ethan", lastName: "Wilson", ageYears: 13 },
      { firstName: "Ava", lastName: "Wilson", ageYears: 10 },
    ],
  },
  {
    primaryContactName: "Daniel Tran",
    primaryContactEmail: "dan.tran@example.com",
    primaryContactPhone: "+61 478 555 121",
    suburb: "North Ryde",
    state: "NSW",
    postcode: "2113",
    students: [
      { firstName: "Lily", lastName: "Tran", ageYears: 3 },
    ],
  },
  {
    primaryContactName: "Emily Robinson",
    primaryContactEmail: "emily.robinson@example.com",
    suburb: "Hornsby",
    state: "NSW",
    postcode: "2077",
    students: [
      { firstName: "Oliver", lastName: "Robinson", ageYears: 6 },
      { firstName: "Sophie", lastName: "Robinson", ageYears: 2 },
    ],
  },
];

const COASTAL_FAMILIES: FamilySeed[] = [
  {
    primaryContactName: "Tom Mackenzie",
    primaryContactEmail: "tom.mackenzie@example.com",
    primaryContactPhone: "+61 405 111 999",
    suburb: "Bondi",
    state: "NSW",
    postcode: "2026",
    students: [
      { firstName: "Hugo", lastName: "Mackenzie", ageYears: 4 },
      { firstName: "Eloise", lastName: "Mackenzie", ageYears: 7 },
    ],
  },
  {
    primaryContactName: "Aisha Rahman",
    primaryContactEmail: "aisha.rahman@example.com",
    suburb: "Coogee",
    state: "NSW",
    postcode: "2034",
    communicationPreference: "email",
    students: [
      { firstName: "Zaynab", lastName: "Rahman", ageYears: 12 },
    ],
  },
  {
    primaryContactName: "Marco Bianchi",
    primaryContactEmail: "marco.bianchi@example.com",
    primaryContactPhone: "+61 419 020 030",
    suburb: "Maroubra",
    state: "NSW",
    postcode: "2035",
    notes: "Asthma — inhaler in poolside bag.",
    students: [
      { firstName: "Luca", lastName: "Bianchi", ageYears: 9 },
      { firstName: "Sofia", lastName: "Bianchi", ageYears: 6 },
      { firstName: "Matteo", lastName: "Bianchi", ageYears: 1 },
    ],
  },
  {
    primaryContactName: "Rebecca Lee",
    primaryContactEmail: "rebecca.lee@example.com",
    suburb: "Randwick",
    state: "NSW",
    postcode: "2031",
    students: [
      { firstName: "Grace", lastName: "Lee", ageYears: 8, status: "paused" },
      { firstName: "Henry", lastName: "Lee", ageYears: 5 },
    ],
  },
  {
    primaryContactName: "Jake Anderson",
    primaryContactEmail: "jake.anderson@example.com",
    primaryContactPhone: "+61 422 808 808",
    suburb: "Clovelly",
    state: "NSW",
    postcode: "2031",
    students: [
      { firstName: "Tessa", lastName: "Anderson", ageYears: 13 },
    ],
  },
];

function dobFromAgeYears(age: number): string {
  const now = new Date();
  const dob = new Date(
    now.getFullYear() - age,
    now.getMonth(),
    now.getDate(),
  );
  // YYYY-MM-DD for the DATE column
  return dob.toISOString().slice(0, 10);
}

async function seedFamilies(
  prisma: PrismaClient,
  schoolSlug: string,
  families: FamilySeed[],
) {
  // Look up the school id by slug. Seeds run as admin → no RLS in the way.
  const school = await prisma.school.findUnique({
    where: { slug: schoolSlug },
    select: { id: true },
  });
  if (!school) {
    throw new Error(`seed: school ${schoolSlug} not found`);
  }

  for (const fam of families) {
    // Idempotent upsert keyed on (school_id, primary_contact_email). No
    // unique index on that pair, so we do find-or-insert by hand.
    const existing = await prisma.family.findFirst({
      where: {
        schoolId: school.id,
        primaryContactEmail: fam.primaryContactEmail,
      },
      select: { id: true },
    });

    let familyId: string;
    if (existing) {
      familyId = existing.id;
      await prisma.$executeRaw`
        UPDATE families SET
          primary_contact_name = ${fam.primaryContactName},
          primary_contact_phone = ${fam.primaryContactPhone ?? null},
          suburb = ${fam.suburb ?? null},
          state = ${fam.state ?? null},
          postcode = ${fam.postcode ?? null},
          communication_preference = ${fam.communicationPreference ?? "email"}::communication_preference,
          notes = ${fam.notes ?? null},
          updated_at = now()
        WHERE id = ${familyId}::uuid
      `;
    } else {
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO families (
          school_id, primary_contact_name, primary_contact_email,
          primary_contact_phone, suburb, state, postcode,
          communication_preference, notes,
          created_by, updated_by, updated_at
        )
        VALUES (
          ${school.id}::uuid, ${fam.primaryContactName}, ${fam.primaryContactEmail},
          ${fam.primaryContactPhone ?? null}, ${fam.suburb ?? null}, ${fam.state ?? null}, ${fam.postcode ?? null},
          ${fam.communicationPreference ?? "email"}::communication_preference, ${fam.notes ?? null},
          ${SYSTEM_USER_ID}::uuid, ${SYSTEM_USER_ID}::uuid, now()
        )
        RETURNING id
      `;
      familyId = rows[0]!.id;
    }

    for (const student of fam.students) {
      // Match on (family_id, first_name, last_name). DOB is computed from
      // age each run and would otherwise drift, breaking idempotency.
      const studentExisting = await prisma.student.findFirst({
        where: {
          familyId,
          firstName: student.firstName,
          lastName: student.lastName,
        },
        select: { id: true },
      });

      const dob = dobFromAgeYears(student.ageYears);
      const status = student.status ?? "active";

      if (studentExisting) {
        await prisma.$executeRaw`
          UPDATE students SET
            date_of_birth = ${dob}::date,
            status = ${status}::student_status,
            updated_at = now()
          WHERE id = ${studentExisting.id}::uuid
        `;
      } else {
        await prisma.$executeRaw`
          INSERT INTO students (
            school_id, family_id, first_name, last_name, date_of_birth, status,
            created_by, updated_by, updated_at
          )
          VALUES (
            ${school.id}::uuid, ${familyId}::uuid, ${student.firstName}, ${student.lastName}, ${dob}::date, ${status}::student_status,
            ${SYSTEM_USER_ID}::uuid, ${SYSTEM_USER_ID}::uuid, now()
          )
        `;
      }
    }
  }
}

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

    await seedFamilies(prisma, "riverside", RIVERSIDE_FAMILIES);
    await seedFamilies(prisma, "coastal", COASTAL_FAMILIES);

    const familyCount = await prisma.family.count();
    const studentCount = await prisma.student.count();
    console.log(`Seeded families: ${familyCount}, students: ${studentCount}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
