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

type LocationSeed = {
  name: string;
  timezone?: string;
};

type TeacherSeed = {
  email: string;
  name: string;
};

type ClassLevelSeed = {
  name: string;
  description?: string;
  ratio: number;
  orderIndex: number;
  minAgeMonths?: number;
  maxAgeMonths?: number;
  defaultProgressionThreshold?: number;
};

type DayOfWeek =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

type ClassSeed = {
  // References by name within the same school — resolved at insert time.
  locationName: string;
  levelName: string;
  teacherEmail: string;
  dayOfWeek: DayOfWeek;
  startTime: string; // HH:MM:SS
  durationMinutes: number;
  capacity: number;
};

type EnrolmentSeed = {
  // References by name. Student is matched by (firstName, lastName) within
  // the school; class by (locationName, levelName, dayOfWeek, startTime).
  studentFirstName: string;
  studentLastName: string;
  classLocationName: string;
  classLevelName: string;
  classDayOfWeek: DayOfWeek;
  classStartTime: string;
  frequency: "weekly" | "fortnightly_a" | "fortnightly_b" | "one_off";
  // Days from "today" — negative is past, positive is future. Resolved at
  // seed time so the result is always realistic.
  startOffsetDays: number;
  endOffsetDays?: number | null;
  pauseFromOffsetDays?: number | null;
  pauseToOffsetDays?: number | null;
  status?: "active" | "paused" | "withdrawn";
  notes?: string;
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

const RIVERSIDE_LOCATIONS: LocationSeed[] = [
  { name: "Parramatta Pool", timezone: "Australia/Sydney" },
  { name: "Ryde Aquatic", timezone: "Australia/Sydney" },
];

const COASTAL_LOCATIONS: LocationSeed[] = [
  { name: "Bondi Pavilion", timezone: "Australia/Sydney" },
  { name: "Maroubra Beach Pool", timezone: "Australia/Sydney" },
];

const RIVERSIDE_TEACHERS: TeacherSeed[] = [
  { email: "alice.kim@riverside.test", name: "Alice Kim" },
  { email: "ben.taylor@riverside.test", name: "Ben Taylor" },
];

const COASTAL_TEACHERS: TeacherSeed[] = [
  { email: "carla.singh@coastal.test", name: "Carla Singh" },
  { email: "david.brown@coastal.test", name: "David Brown" },
];

const RIVERSIDE_LEVELS: ClassLevelSeed[] = [
  {
    name: "Infants",
    description: "Parent-and-child water familiarisation",
    ratio: 4,
    orderIndex: 0,
    minAgeMonths: 6,
    maxAgeMonths: 24,
  },
  {
    name: "Beginner",
    description: "Independent intro: floats, kicks, breath control",
    ratio: 6,
    orderIndex: 1,
    minAgeMonths: 24,
    maxAgeMonths: 60,
  },
  {
    name: "Intermediate",
    description: "Stroke development across freestyle and backstroke",
    ratio: 8,
    orderIndex: 2,
    minAgeMonths: 60,
    maxAgeMonths: 120,
  },
  {
    name: "Advanced",
    description: "All four strokes, distance work",
    ratio: 8,
    orderIndex: 3,
    minAgeMonths: 96,
  },
];

// Coastal varies the ratio mix and the top tier name to make it obvious the
// two schools' frameworks are independent, not a shared template.
const COASTAL_LEVELS: ClassLevelSeed[] = [
  {
    name: "Infants",
    description: "Parent-and-child water familiarisation",
    ratio: 4,
    orderIndex: 0,
    minAgeMonths: 6,
    maxAgeMonths: 24,
  },
  {
    name: "Beginner",
    description: "Independent intro to deep-water confidence",
    ratio: 5,
    orderIndex: 1,
    minAgeMonths: 24,
    maxAgeMonths: 60,
  },
  {
    name: "Intermediate",
    description: "Stroke refinement, endurance",
    ratio: 7,
    orderIndex: 2,
    minAgeMonths: 60,
    maxAgeMonths: 120,
  },
  {
    name: "Pre-Squad",
    description: "Squad-prep technique and pace work",
    ratio: 6,
    orderIndex: 3,
    minAgeMonths: 96,
    defaultProgressionThreshold: 90,
  },
];

const RIVERSIDE_CLASSES: ClassSeed[] = [
  {
    locationName: "Parramatta Pool",
    levelName: "Infants",
    teacherEmail: "alice.kim@riverside.test",
    dayOfWeek: "monday",
    startTime: "16:00:00",
    durationMinutes: 30,
    capacity: 4,
  },
  {
    locationName: "Parramatta Pool",
    levelName: "Beginner",
    teacherEmail: "alice.kim@riverside.test",
    dayOfWeek: "monday",
    startTime: "16:30:00",
    durationMinutes: 30,
    capacity: 6,
  },
  {
    locationName: "Parramatta Pool",
    levelName: "Intermediate",
    teacherEmail: "ben.taylor@riverside.test",
    dayOfWeek: "wednesday",
    startTime: "17:30:00",
    durationMinutes: 45,
    capacity: 8,
  },
  {
    locationName: "Ryde Aquatic",
    levelName: "Beginner",
    teacherEmail: "ben.taylor@riverside.test",
    dayOfWeek: "tuesday",
    startTime: "16:00:00",
    durationMinutes: 30,
    capacity: 6,
  },
  {
    locationName: "Ryde Aquatic",
    levelName: "Advanced",
    teacherEmail: "ben.taylor@riverside.test",
    dayOfWeek: "thursday",
    startTime: "18:00:00",
    durationMinutes: 60,
    capacity: 8,
  },
  {
    locationName: "Ryde Aquatic",
    levelName: "Infants",
    teacherEmail: "alice.kim@riverside.test",
    dayOfWeek: "saturday",
    startTime: "09:00:00",
    durationMinutes: 30,
    capacity: 4,
  },
];

const RIVERSIDE_ENROLMENTS: EnrolmentSeed[] = [
  {
    studentFirstName: "Mia",
    studentLastName: "Nguyen",
    classLocationName: "Parramatta Pool",
    classLevelName: "Intermediate",
    classDayOfWeek: "wednesday",
    classStartTime: "17:30:00",
    frequency: "weekly",
    startOffsetDays: -56,
  },
  {
    studentFirstName: "Leo",
    studentLastName: "Nguyen",
    classLocationName: "Parramatta Pool",
    classLevelName: "Beginner",
    classDayOfWeek: "monday",
    classStartTime: "16:30:00",
    frequency: "weekly",
    startOffsetDays: -56,
  },
  {
    studentFirstName: "Aarav",
    studentLastName: "Patel",
    classLocationName: "Ryde Aquatic",
    classLevelName: "Advanced",
    classDayOfWeek: "thursday",
    classStartTime: "18:00:00",
    frequency: "weekly",
    startOffsetDays: -56,
  },
  {
    studentFirstName: "Ishani",
    studentLastName: "Patel",
    classLocationName: "Parramatta Pool",
    classLevelName: "Intermediate",
    classDayOfWeek: "wednesday",
    classStartTime: "17:30:00",
    frequency: "weekly",
    startOffsetDays: -56,
  },
  {
    studentFirstName: "Vihaan",
    studentLastName: "Patel",
    classLocationName: "Parramatta Pool",
    classLevelName: "Infants",
    classDayOfWeek: "monday",
    classStartTime: "16:00:00",
    frequency: "fortnightly_a",
    startOffsetDays: -56,
  },
  {
    studentFirstName: "Sophie",
    studentLastName: "Robinson",
    classLocationName: "Parramatta Pool",
    classLevelName: "Infants",
    classDayOfWeek: "monday",
    classStartTime: "16:00:00",
    frequency: "fortnightly_b",
    startOffsetDays: -56,
  },
  {
    studentFirstName: "Ethan",
    studentLastName: "Wilson",
    classLocationName: "Ryde Aquatic",
    classLevelName: "Advanced",
    classDayOfWeek: "thursday",
    classStartTime: "18:00:00",
    frequency: "weekly",
    startOffsetDays: -56,
  },
  {
    studentFirstName: "Ava",
    studentLastName: "Wilson",
    classLocationName: "Parramatta Pool",
    classLevelName: "Intermediate",
    classDayOfWeek: "wednesday",
    classStartTime: "17:30:00",
    frequency: "fortnightly_a",
    startOffsetDays: -56,
  },
  {
    studentFirstName: "Oliver",
    studentLastName: "Robinson",
    classLocationName: "Parramatta Pool",
    classLevelName: "Intermediate",
    classDayOfWeek: "wednesday",
    classStartTime: "17:30:00",
    frequency: "fortnightly_b",
    startOffsetDays: -56,
  },
  {
    studentFirstName: "Lily",
    studentLastName: "Tran",
    classLocationName: "Ryde Aquatic",
    classLevelName: "Infants",
    classDayOfWeek: "saturday",
    classStartTime: "09:00:00",
    frequency: "weekly",
    startOffsetDays: -56,
  },
  {
    studentFirstName: "Mia",
    studentLastName: "Nguyen",
    classLocationName: "Ryde Aquatic",
    classLevelName: "Infants",
    classDayOfWeek: "saturday",
    classStartTime: "09:00:00",
    frequency: "one_off",
    startOffsetDays: -7,
    notes: "Trial class — sibling visit.",
  },
  {
    studentFirstName: "Charlotte",
    studentLastName: "O'Connor",
    classLocationName: "Ryde Aquatic",
    classLevelName: "Beginner",
    classDayOfWeek: "tuesday",
    classStartTime: "16:00:00",
    frequency: "weekly",
    startOffsetDays: -56,
    pauseFromOffsetDays: -3,
    pauseToOffsetDays: 28,
    status: "paused",
    notes: "On family holiday.",
  },
  {
    studentFirstName: "Aarav",
    studentLastName: "Patel",
    classLocationName: "Ryde Aquatic",
    classLevelName: "Beginner",
    classDayOfWeek: "tuesday",
    classStartTime: "16:00:00",
    frequency: "weekly",
    startOffsetDays: -120,
    endOffsetDays: -30,
    status: "withdrawn",
    notes: "Moved to Advanced.",
  },
];

const COASTAL_ENROLMENTS: EnrolmentSeed[] = [
  {
    studentFirstName: "Hugo",
    studentLastName: "Mackenzie",
    classLocationName: "Bondi Pavilion",
    classLevelName: "Infants",
    classDayOfWeek: "tuesday",
    classStartTime: "16:00:00",
    frequency: "weekly",
    startOffsetDays: -56,
  },
  {
    studentFirstName: "Eloise",
    studentLastName: "Mackenzie",
    classLocationName: "Bondi Pavilion",
    classLevelName: "Beginner",
    classDayOfWeek: "tuesday",
    classStartTime: "16:30:00",
    frequency: "weekly",
    startOffsetDays: -56,
  },
  {
    studentFirstName: "Zaynab",
    studentLastName: "Rahman",
    classLocationName: "Bondi Pavilion",
    classLevelName: "Intermediate",
    classDayOfWeek: "thursday",
    classStartTime: "17:30:00",
    frequency: "weekly",
    startOffsetDays: -56,
  },
  {
    studentFirstName: "Luca",
    studentLastName: "Bianchi",
    classLocationName: "Bondi Pavilion",
    classLevelName: "Intermediate",
    classDayOfWeek: "thursday",
    classStartTime: "17:30:00",
    frequency: "fortnightly_a",
    startOffsetDays: -56,
  },
  {
    studentFirstName: "Sofia",
    studentLastName: "Bianchi",
    classLocationName: "Bondi Pavilion",
    classLevelName: "Beginner",
    classDayOfWeek: "tuesday",
    classStartTime: "16:30:00",
    frequency: "fortnightly_b",
    startOffsetDays: -56,
  },
  {
    studentFirstName: "Matteo",
    studentLastName: "Bianchi",
    classLocationName: "Bondi Pavilion",
    classLevelName: "Infants",
    classDayOfWeek: "tuesday",
    classStartTime: "16:00:00",
    frequency: "fortnightly_a",
    startOffsetDays: -56,
  },
  {
    studentFirstName: "Grace",
    studentLastName: "Lee",
    classLocationName: "Maroubra Beach Pool",
    classLevelName: "Beginner",
    classDayOfWeek: "wednesday",
    classStartTime: "16:00:00",
    frequency: "fortnightly_b",
    startOffsetDays: -56,
  },
  {
    studentFirstName: "Henry",
    studentLastName: "Lee",
    classLocationName: "Maroubra Beach Pool",
    classLevelName: "Beginner",
    classDayOfWeek: "wednesday",
    classStartTime: "16:00:00",
    frequency: "weekly",
    startOffsetDays: -56,
  },
  {
    studentFirstName: "Tessa",
    studentLastName: "Anderson",
    classLocationName: "Maroubra Beach Pool",
    classLevelName: "Pre-Squad",
    classDayOfWeek: "friday",
    classStartTime: "18:00:00",
    frequency: "weekly",
    startOffsetDays: -56,
  },
  {
    studentFirstName: "Eloise",
    studentLastName: "Mackenzie",
    classLocationName: "Maroubra Beach Pool",
    classLevelName: "Infants",
    classDayOfWeek: "saturday",
    classStartTime: "08:30:00",
    frequency: "one_off",
    startOffsetDays: -7,
    notes: "Trial class.",
  },
  {
    studentFirstName: "Hugo",
    studentLastName: "Mackenzie",
    classLocationName: "Bondi Pavilion",
    classLevelName: "Beginner",
    classDayOfWeek: "tuesday",
    classStartTime: "16:30:00",
    frequency: "weekly",
    startOffsetDays: -56,
    pauseFromOffsetDays: -3,
    pauseToOffsetDays: 28,
    status: "paused",
    notes: "Recovering from ear infection.",
  },
  {
    studentFirstName: "Zaynab",
    studentLastName: "Rahman",
    classLocationName: "Maroubra Beach Pool",
    classLevelName: "Pre-Squad",
    classDayOfWeek: "friday",
    classStartTime: "18:00:00",
    frequency: "weekly",
    startOffsetDays: -120,
    endOffsetDays: -30,
    status: "withdrawn",
    notes: "Family relocated.",
  },
];

const COASTAL_CLASSES: ClassSeed[] = [
  {
    locationName: "Bondi Pavilion",
    levelName: "Infants",
    teacherEmail: "carla.singh@coastal.test",
    dayOfWeek: "tuesday",
    startTime: "16:00:00",
    durationMinutes: 30,
    capacity: 4,
  },
  {
    locationName: "Bondi Pavilion",
    levelName: "Beginner",
    teacherEmail: "carla.singh@coastal.test",
    dayOfWeek: "tuesday",
    startTime: "16:30:00",
    durationMinutes: 30,
    capacity: 5,
  },
  {
    locationName: "Bondi Pavilion",
    levelName: "Intermediate",
    teacherEmail: "david.brown@coastal.test",
    dayOfWeek: "thursday",
    startTime: "17:30:00",
    durationMinutes: 45,
    capacity: 7,
  },
  {
    locationName: "Maroubra Beach Pool",
    levelName: "Beginner",
    teacherEmail: "david.brown@coastal.test",
    dayOfWeek: "wednesday",
    startTime: "16:00:00",
    durationMinutes: 30,
    capacity: 5,
  },
  {
    locationName: "Maroubra Beach Pool",
    levelName: "Pre-Squad",
    teacherEmail: "david.brown@coastal.test",
    dayOfWeek: "friday",
    startTime: "18:00:00",
    durationMinutes: 60,
    capacity: 6,
  },
  {
    locationName: "Maroubra Beach Pool",
    levelName: "Infants",
    teacherEmail: "carla.singh@coastal.test",
    dayOfWeek: "saturday",
    startTime: "08:30:00",
    durationMinutes: 30,
    capacity: 4,
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

async function seedLocations(
  prisma: PrismaClient,
  schoolSlug: string,
  locations: LocationSeed[],
) {
  const school = await prisma.school.findUnique({
    where: { slug: schoolSlug },
    select: { id: true },
  });
  if (!school) throw new Error(`seed: school ${schoolSlug} not found`);

  for (const loc of locations) {
    // No (school_id, name) unique index on locations, so find-or-insert.
    const existing = await prisma.location.findFirst({
      where: { schoolId: school.id, name: loc.name },
      select: { id: true },
    });
    if (existing) {
      await prisma.$executeRaw`
        UPDATE locations SET timezone = ${loc.timezone ?? null}, updated_at = now()
        WHERE id = ${existing.id}::uuid
      `;
    } else {
      await prisma.$executeRaw`
        INSERT INTO locations (school_id, name, timezone, created_by, updated_by, updated_at)
        VALUES (${school.id}::uuid, ${loc.name}, ${loc.timezone ?? null},
                ${SYSTEM_USER_ID}::uuid, ${SYSTEM_USER_ID}::uuid, now())
      `;
    }
  }
}

async function seedTeachers(
  prisma: PrismaClient,
  schoolSlug: string,
  teachers: TeacherSeed[],
) {
  const school = await prisma.school.findUnique({
    where: { slug: schoolSlug },
    select: { id: true },
  });
  if (!school) throw new Error(`seed: school ${schoolSlug} not found`);

  for (const t of teachers) {
    // Users are global; upsert by unique email and then ensure a membership.
    const user = await prisma.user.upsert({
      where: { email: t.email },
      update: { name: t.name },
      create: { email: t.email, name: t.name },
      select: { id: true },
    });

    const existingMembership = await prisma.membership.findUnique({
      where: { schoolId_userId: { schoolId: school.id, userId: user.id } },
      select: { id: true },
    });
    if (!existingMembership) {
      await prisma.$executeRaw`
        INSERT INTO memberships (school_id, user_id, role, created_by, updated_by, updated_at)
        VALUES (${school.id}::uuid, ${user.id}::uuid, 'teacher',
                ${SYSTEM_USER_ID}::uuid, ${SYSTEM_USER_ID}::uuid, now())
      `;
    }
  }
}

async function seedClassLevels(
  prisma: PrismaClient,
  schoolSlug: string,
  levels: ClassLevelSeed[],
) {
  const school = await prisma.school.findUnique({
    where: { slug: schoolSlug },
    select: { id: true },
  });
  if (!school) throw new Error(`seed: school ${schoolSlug} not found`);

  for (const lvl of levels) {
    // Idempotent on the (school_id, name) unique index.
    await prisma.$executeRaw`
      INSERT INTO class_levels (
        school_id, name, description, ratio, order_index,
        min_age_months, max_age_months, default_progression_threshold,
        created_by, updated_by, updated_at
      ) VALUES (
        ${school.id}::uuid, ${lvl.name}, ${lvl.description ?? null},
        ${lvl.ratio}, ${lvl.orderIndex},
        ${lvl.minAgeMonths ?? null}, ${lvl.maxAgeMonths ?? null},
        ${lvl.defaultProgressionThreshold ?? 80},
        ${SYSTEM_USER_ID}::uuid, ${SYSTEM_USER_ID}::uuid, now()
      )
      ON CONFLICT (school_id, name) DO UPDATE SET
        description = EXCLUDED.description,
        ratio = EXCLUDED.ratio,
        order_index = EXCLUDED.order_index,
        min_age_months = EXCLUDED.min_age_months,
        max_age_months = EXCLUDED.max_age_months,
        default_progression_threshold = EXCLUDED.default_progression_threshold,
        updated_at = now()
    `;
  }
}

async function seedClasses(
  prisma: PrismaClient,
  schoolSlug: string,
  classes: ClassSeed[],
) {
  const school = await prisma.school.findUnique({
    where: { slug: schoolSlug },
    select: { id: true },
  });
  if (!school) throw new Error(`seed: school ${schoolSlug} not found`);

  for (const c of classes) {
    const location = await prisma.location.findFirst({
      where: { schoolId: school.id, name: c.locationName },
      select: { id: true },
    });
    if (!location) {
      throw new Error(
        `seed: location "${c.locationName}" missing in ${schoolSlug}`,
      );
    }
    const level = await prisma.classLevel.findFirst({
      where: { schoolId: school.id, name: c.levelName },
      select: { id: true },
    });
    if (!level) {
      throw new Error(
        `seed: class_level "${c.levelName}" missing in ${schoolSlug}`,
      );
    }
    const teacher = await prisma.user.findUnique({
      where: { email: c.teacherEmail },
      select: { id: true },
    });
    if (!teacher) {
      throw new Error(`seed: teacher ${c.teacherEmail} missing`);
    }

    // No unique index on (school_id, location_id, level_id, day_of_week,
    // start_time) — match by hand.
    const existing = await prisma.class.findFirst({
      where: {
        schoolId: school.id,
        locationId: location.id,
        levelId: level.id,
        dayOfWeek: c.dayOfWeek,
        startTime: new Date(`1970-01-01T${c.startTime}Z`),
      },
      select: { id: true },
    });
    if (existing) {
      await prisma.$executeRaw`
        UPDATE classes SET
          teacher_id = ${teacher.id}::uuid,
          duration_minutes = ${c.durationMinutes},
          capacity = ${c.capacity},
          updated_at = now()
        WHERE id = ${existing.id}::uuid
      `;
    } else {
      await prisma.$executeRaw`
        INSERT INTO classes (
          school_id, location_id, level_id, teacher_id,
          day_of_week, start_time, duration_minutes, capacity,
          created_by, updated_by, updated_at
        ) VALUES (
          ${school.id}::uuid, ${location.id}::uuid, ${level.id}::uuid, ${teacher.id}::uuid,
          ${c.dayOfWeek}::week_day, ${c.startTime}::time,
          ${c.durationMinutes}, ${c.capacity},
          ${SYSTEM_USER_ID}::uuid, ${SYSTEM_USER_ID}::uuid, now()
        )
      `;
    }
  }
}

const DOW_INDEX: Record<DayOfWeek, number> = {
  // JS getUTCDay: Sunday=0, Monday=1, ..., Saturday=6.
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const MS_PER_DAY = 86_400_000;

function utcMidnightToday(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function offsetFromToday(today: Date, days: number): Date {
  return new Date(today.getTime() + days * MS_PER_DAY);
}

function snapToDayOfWeek(d: Date, dow: DayOfWeek): Date {
  // First occurrence of `dow` on or after `d` (UTC).
  const target = DOW_INDEX[dow];
  const offset = (target - d.getUTCDay() + 7) % 7;
  return new Date(d.getTime() + offset * MS_PER_DAY);
}

function mostRecentOccurrence(today: Date, dow: DayOfWeek): Date {
  // Most recent occurrence of `dow` on or before `today`.
  const target = DOW_INDEX[dow];
  const offset = (today.getUTCDay() - target + 7) % 7;
  return new Date(today.getTime() - offset * MS_PER_DAY);
}

function qualifiesOnDate(
  enrolment: {
    frequency: EnrolmentSeed["frequency"];
    startDate: Date;
    endDate: Date | null;
    pauseFrom: Date | null;
    pauseTo: Date | null;
    status: "active" | "paused" | "withdrawn";
  },
  date: Date,
): boolean {
  // Mirror of expandEnrolmentDates' core rules — kept self-contained inside
  // the seed so it doesn't pull domain code into the migration runner.
  if (enrolment.status === "withdrawn") return false;
  if (date.getTime() < enrolment.startDate.getTime()) return false;
  if (
    enrolment.endDate &&
    date.getTime() > enrolment.endDate.getTime()
  ) {
    return false;
  }
  if (
    enrolment.pauseFrom &&
    enrolment.pauseTo &&
    date.getTime() >= enrolment.pauseFrom.getTime() &&
    date.getTime() <= enrolment.pauseTo.getTime()
  ) {
    return false;
  }
  if (
    enrolment.frequency === "fortnightly_a" ||
    enrolment.frequency === "fortnightly_b"
  ) {
    const weeks = Math.floor(
      (date.getTime() - enrolment.startDate.getTime()) / (7 * MS_PER_DAY),
    );
    const isEven = weeks % 2 === 0;
    if (enrolment.frequency === "fortnightly_a" && !isEven) return false;
    if (enrolment.frequency === "fortnightly_b" && isEven) return false;
  }
  if (enrolment.frequency === "one_off") {
    return date.getTime() === enrolment.startDate.getTime();
  }
  return true;
}

type ResolvedEnrolment = {
  id: string;
  schoolId: string;
  classId: string;
  studentId: string;
  classDayOfWeek: DayOfWeek;
  classTeacherId: string;
  frequency: EnrolmentSeed["frequency"];
  startDate: Date;
  endDate: Date | null;
  pauseFrom: Date | null;
  pauseTo: Date | null;
  status: "active" | "paused" | "withdrawn";
};

async function seedEnrolments(
  prisma: PrismaClient,
  schoolSlug: string,
  enrolments: EnrolmentSeed[],
): Promise<ResolvedEnrolment[]> {
  const school = await prisma.school.findUnique({
    where: { slug: schoolSlug },
    select: { id: true },
  });
  if (!school) throw new Error(`seed: school ${schoolSlug} not found`);

  const today = utcMidnightToday();
  const resolved: ResolvedEnrolment[] = [];

  for (const e of enrolments) {
    const student = await prisma.student.findFirst({
      where: {
        schoolId: school.id,
        firstName: e.studentFirstName,
        lastName: e.studentLastName,
      },
      select: { id: true },
    });
    if (!student) {
      throw new Error(
        `seed: student ${e.studentFirstName} ${e.studentLastName} missing in ${schoolSlug}`,
      );
    }
    const location = await prisma.location.findFirst({
      where: { schoolId: school.id, name: e.classLocationName },
      select: { id: true },
    });
    if (!location) {
      throw new Error(
        `seed: location ${e.classLocationName} missing in ${schoolSlug}`,
      );
    }
    const level = await prisma.classLevel.findFirst({
      where: { schoolId: school.id, name: e.classLevelName },
      select: { id: true },
    });
    if (!level) {
      throw new Error(
        `seed: level ${e.classLevelName} missing in ${schoolSlug}`,
      );
    }
    const klass = await prisma.class.findFirst({
      where: {
        schoolId: school.id,
        locationId: location.id,
        levelId: level.id,
        dayOfWeek: e.classDayOfWeek,
        startTime: new Date(`1970-01-01T${e.classStartTime}Z`),
      },
      select: { id: true, dayOfWeek: true, teacherId: true },
    });
    if (!klass || !klass.teacherId) {
      throw new Error(
        `seed: class for enrolment of ${e.studentFirstName} ${e.studentLastName} not found or has no teacher`,
      );
    }

    // Snap startDate to the class's day-of-week so the fortnightly anchor is
    // sensible and one_off enrolments land on a date the class actually runs.
    const startCandidate = offsetFromToday(today, e.startOffsetDays);
    const startDate = snapToDayOfWeek(startCandidate, e.classDayOfWeek);
    const endDate =
      e.frequency === "one_off"
        ? startDate
        : e.endOffsetDays !== undefined && e.endOffsetDays !== null
          ? offsetFromToday(today, e.endOffsetDays)
          : null;
    const pauseFrom =
      e.pauseFromOffsetDays !== undefined && e.pauseFromOffsetDays !== null
        ? offsetFromToday(today, e.pauseFromOffsetDays)
        : null;
    const pauseTo =
      e.pauseToOffsetDays !== undefined && e.pauseToOffsetDays !== null
        ? offsetFromToday(today, e.pauseToOffsetDays)
        : null;
    const status = e.status ?? "active";

    // Idempotency key: (school, student, class, start_date). No unique
    // index on these — hand-rolled find-or-insert.
    const existing = await prisma.enrolment.findFirst({
      where: {
        schoolId: school.id,
        studentId: student.id,
        classId: klass.id,
        startDate,
      },
      select: { id: true },
    });
    let id: string;
    if (existing) {
      id = existing.id;
      await prisma.$executeRaw`
        UPDATE enrolments SET
          frequency = ${e.frequency}::enrolment_frequency,
          end_date = ${endDate ? isoDate(endDate) : null}::date,
          pause_from = ${pauseFrom ? isoDate(pauseFrom) : null}::date,
          pause_to = ${pauseTo ? isoDate(pauseTo) : null}::date,
          status = ${status}::enrolment_status,
          notes = ${e.notes ?? null},
          updated_at = now()
        WHERE id = ${id}::uuid
      `;
    } else {
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO enrolments (
          school_id, student_id, class_id, frequency,
          start_date, end_date, pause_from, pause_to, status, notes,
          created_by, updated_by, updated_at
        ) VALUES (
          ${school.id}::uuid, ${student.id}::uuid, ${klass.id}::uuid,
          ${e.frequency}::enrolment_frequency,
          ${isoDate(startDate)}::date,
          ${endDate ? isoDate(endDate) : null}::date,
          ${pauseFrom ? isoDate(pauseFrom) : null}::date,
          ${pauseTo ? isoDate(pauseTo) : null}::date,
          ${status}::enrolment_status, ${e.notes ?? null},
          ${SYSTEM_USER_ID}::uuid, ${SYSTEM_USER_ID}::uuid, now()
        ) RETURNING id
      `;
      id = rows[0]!.id;
    }

    resolved.push({
      id,
      schoolId: school.id,
      classId: klass.id,
      studentId: student.id,
      classDayOfWeek: klass.dayOfWeek as DayOfWeek,
      classTeacherId: klass.teacherId,
      frequency: e.frequency,
      startDate,
      endDate,
      pauseFrom,
      pauseTo,
      status,
    });
  }

  return resolved;
}

async function seedSessionsAndAttendance(
  prisma: PrismaClient,
  schoolSlug: string,
  resolvedEnrolments: ResolvedEnrolment[],
) {
  const school = await prisma.school.findUnique({
    where: { slug: schoolSlug },
    select: { id: true },
  });
  if (!school) throw new Error(`seed: school ${schoolSlug} not found`);

  const today = utcMidnightToday();

  // Group enrolments by class. Then for each class compute the most recent
  // two occurrences of its day_of_week and materialise sessions there.
  const byClass = new Map<string, ResolvedEnrolment[]>();
  for (const e of resolvedEnrolments) {
    if (!byClass.has(e.classId)) byClass.set(e.classId, []);
    byClass.get(e.classId)!.push(e);
  }

  // Mostly-present mix with a sprinkle of variety, deterministic by index.
  const STATUS_MIX: Array<"present" | "absent" | "late"> = [
    "present",
    "present",
    "present",
    "present",
    "late",
    "present",
    "absent",
    "present",
  ];

  let cursor = 0;
  for (const [classId, enrolmentsForClass] of byClass) {
    const dow = enrolmentsForClass[0]!.classDayOfWeek;
    const teacherId = enrolmentsForClass[0]!.classTeacherId;
    const lastOccurrence = mostRecentOccurrence(today, dow);
    const priorOccurrence = new Date(
      lastOccurrence.getTime() - 7 * MS_PER_DAY,
    );

    for (const sessionDate of [priorOccurrence, lastOccurrence]) {
      // getOrCreateSession-equivalent: idempotent via the unique
      // (class_id, session_date) constraint. Snapshots teacher_id at
      // creation time.
      const existing = await prisma.classSession.findUnique({
        where: { classId_sessionDate: { classId, sessionDate } },
        select: { id: true },
      });
      let sessionId: string;
      if (existing) {
        sessionId = existing.id;
      } else {
        const rows = await prisma.$queryRaw<Array<{ id: string }>>`
          INSERT INTO class_sessions (
            school_id, class_id, session_date, teacher_id,
            created_by, updated_by, updated_at
          ) VALUES (
            ${school.id}::uuid, ${classId}::uuid, ${isoDate(sessionDate)}::date,
            ${teacherId}::uuid,
            ${SYSTEM_USER_ID}::uuid, ${SYSTEM_USER_ID}::uuid, now()
          ) RETURNING id
        `;
        sessionId = rows[0]!.id;
      }

      for (const e of enrolmentsForClass) {
        if (!qualifiesOnDate(e, sessionDate)) continue;
        const status = STATUS_MIX[cursor % STATUS_MIX.length]!;
        cursor += 1;

        await prisma.$executeRaw`
          INSERT INTO attendance (
            school_id, class_session_id, enrolment_id, student_id, status,
            created_by, updated_by, updated_at
          ) VALUES (
            ${school.id}::uuid, ${sessionId}::uuid, ${e.id}::uuid, ${e.studentId}::uuid,
            ${status}::attendance_status,
            ${SYSTEM_USER_ID}::uuid, ${SYSTEM_USER_ID}::uuid, now()
          )
          ON CONFLICT (class_session_id, student_id) DO UPDATE
            SET status = EXCLUDED.status,
                enrolment_id = EXCLUDED.enrolment_id,
                updated_at = now()
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

    // Locations / teachers must exist before classes can reference them.
    await seedLocations(prisma, "riverside", RIVERSIDE_LOCATIONS);
    await seedLocations(prisma, "coastal", COASTAL_LOCATIONS);
    await seedTeachers(prisma, "riverside", RIVERSIDE_TEACHERS);
    await seedTeachers(prisma, "coastal", COASTAL_TEACHERS);
    await seedClassLevels(prisma, "riverside", RIVERSIDE_LEVELS);
    await seedClassLevels(prisma, "coastal", COASTAL_LEVELS);
    await seedClasses(prisma, "riverside", RIVERSIDE_CLASSES);
    await seedClasses(prisma, "coastal", COASTAL_CLASSES);

    const levelCount = await prisma.classLevel.count();
    const classCount = await prisma.class.count();
    console.log(`Seeded class levels: ${levelCount}, classes: ${classCount}`);

    // Enrolments + recent sessions/attendance. Idempotent — enrolments
    // matched on (school, student, class, start_date); sessions on the
    // unique (class_id, session_date) index; attendance on
    // (class_session_id, student_id).
    const riversideEnrolments = await seedEnrolments(
      prisma,
      "riverside",
      RIVERSIDE_ENROLMENTS,
    );
    const coastalEnrolments = await seedEnrolments(
      prisma,
      "coastal",
      COASTAL_ENROLMENTS,
    );
    await seedSessionsAndAttendance(prisma, "riverside", riversideEnrolments);
    await seedSessionsAndAttendance(prisma, "coastal", coastalEnrolments);

    const enrolmentCount = await prisma.enrolment.count();
    const sessionCount = await prisma.classSession.count();
    const attendanceCount = await prisma.attendance.count();
    console.log(
      `Seeded enrolments: ${enrolmentCount}, sessions: ${sessionCount}, attendance: ${attendanceCount}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
