import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { PrismaClient } from "@prisma/client";

import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as importRepository from "../../src/repositories/importRepository";
import type { ImportMapping } from "../../src/domain/types";

// Local Prisma client (admin) is used to seed and to read past RLS.
const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const LOCATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-00000000000a";
const LEVEL_BEGINNER = "eeeeeeee-eeee-4eee-8eee-00000000000a";
const LEVEL_INTERMEDIATE = "eeeeeeee-eeee-4eee-8eee-00000000000b";
const CLASS_BEG_MON = "11111111-aaaa-4aaa-8aaa-000000000001";
const CLASS_INT_WED = "11111111-aaaa-4aaa-8aaa-000000000002";

// Headers used by the test CSVs.
const HEADERS = [
  "parent_email",
  "parent_name",
  "parent_phone",
  "first_name",
  "last_name",
  "dob",
  "level",
  "day",
  "time",
  "frequency",
];

const STD_MAPPING: ImportMapping = {
  parent_email: "family.primary_contact_email",
  parent_name: "family.primary_contact_name",
  parent_phone: "family.primary_contact_phone",
  first_name: "student.first_name",
  last_name: "student.last_name",
  dob: "student.date_of_birth",
  level: "enrolment.level_name",
  day: "enrolment.day",
  time: "enrolment.time",
  frequency: "enrolment.frequency",
};

async function seed() {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations, class_levels, classes,
     families, students, enrolments, import_batches RESTART IDENTITY CASCADE`,
  );
  await admin.$executeRaw`
    INSERT INTO users (id, email, name, updated_at) VALUES
      (${USER_ID}::uuid, 'u@example.com', 'U', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${SCHOOL_ID}::uuid, 's', 'S', 'Australia/Sydney', 'AUD', ${USER_ID}::uuid, ${USER_ID}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${SCHOOL_ID}::uuid, ${USER_ID}::uuid, 'owner', ${USER_ID}::uuid, ${USER_ID}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO locations (id, school_id, name, created_by, updated_by, updated_at) VALUES
      (${LOCATION_ID}::uuid, ${SCHOOL_ID}::uuid, 'Pool', ${USER_ID}::uuid, ${USER_ID}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO class_levels (id, school_id, name, ratio, order_index, created_by, updated_by, updated_at) VALUES
      (${LEVEL_BEGINNER}::uuid,    ${SCHOOL_ID}::uuid, 'Beginner', 4, 0, ${USER_ID}::uuid, ${USER_ID}::uuid, now()),
      (${LEVEL_INTERMEDIATE}::uuid, ${SCHOOL_ID}::uuid, 'Intermediate', 6, 1, ${USER_ID}::uuid, ${USER_ID}::uuid, now())
  `;
  // Two classes — Beginner Mon 16:00 (cap 2 to test capacity), Intermediate Wed 17:30 (cap 6).
  await admin.$executeRaw`
    INSERT INTO classes (id, school_id, location_id, level_id, day_of_week, start_time, duration_minutes, capacity, status, created_by, updated_by, updated_at) VALUES
      (${CLASS_BEG_MON}::uuid, ${SCHOOL_ID}::uuid, ${LOCATION_ID}::uuid, ${LEVEL_BEGINNER}::uuid, 'monday', '16:00:00'::time, 30, 2, 'active', ${USER_ID}::uuid, ${USER_ID}::uuid, now()),
      (${CLASS_INT_WED}::uuid, ${SCHOOL_ID}::uuid, ${LOCATION_ID}::uuid, ${LEVEL_INTERMEDIATE}::uuid, 'wednesday', '17:30:00'::time, 30, 6, 'active', ${USER_ID}::uuid, ${USER_ID}::uuid, now())
  `;
}

beforeAll(seed);

beforeEach(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE families, students, enrolments, import_batches RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("importRepository.dryRunImport", () => {
  test("happy path: produces preview counts and writes nothing", async () => {
    const rows = [
      ["a@example.com", "A Adult", "0400", "Aiden", "A", "01/01/2018", "Beginner", "Monday", "16:00", "weekly"],
      ["b@example.com", "B Adult", "0401", "Bea",   "B", "01/01/2019", "Intermediate", "Wednesday", "17:30", "weekly"],
    ];
    const report = await withTenant(
      { schoolId: SCHOOL_ID, userId: USER_ID },
      (tx) =>
        importRepository.dryRunImport(tx, {
          rows,
          headers: HEADERS,
          mapping: STD_MAPPING,
          resolutions: {},
        }),
    );
    expect(report.blocking).toBe(false);
    expect(report.preview.familyCount).toBe(2);
    expect(report.preview.studentCount).toBe(2);
    expect(report.preview.enrolmentCount).toBe(2);
    // Nothing committed.
    const fam = await admin.family.count();
    expect(fam).toBe(0);
  });

  test("rule: missing required email is blocking", async () => {
    const rows = [
      ["", "A Adult", "", "Aiden", "A", "", "Beginner", "Monday", "16:00", "weekly"],
    ];
    const report = await withTenant(
      { schoolId: SCHOOL_ID, userId: USER_ID },
      (tx) =>
        importRepository.dryRunImport(tx, {
          rows,
          headers: HEADERS,
          mapping: STD_MAPPING,
          resolutions: {},
        }),
    );
    expect(report.blocking).toBe(true);
    expect(report.findings.some((f) => f.rule === "missing_required")).toBe(true);
  });

  test("rule: unknown_level offers Levenshtein suggestion within distance 3", async () => {
    const rows = [
      // "Beginer" is 1 char off "Beginner".
      ["x@example.com", "X Adult", "", "Xena", "X", "", "Beginer", "Monday", "16:00", "weekly"],
    ];
    const report = await withTenant(
      { schoolId: SCHOOL_ID, userId: USER_ID },
      (tx) =>
        importRepository.dryRunImport(tx, {
          rows,
          headers: HEADERS,
          mapping: STD_MAPPING,
          resolutions: {},
        }),
    );
    const f = report.findings.find((f) => f.rule === "unknown_level");
    expect(f).toBeDefined();
    expect(f?.message).toMatch(/did you mean "Beginner"/);
    expect(f?.resolution?.kind).toBe("use_suggested_level");
    expect(
      (f?.resolution?.payload as { levelId?: string })?.levelId,
    ).toBe(LEVEL_BEGINNER);
  });

  test("rule: capacity_breach is a warning that lets commit through", async () => {
    // Beginner Mon 16:00 has capacity 2. Three rows enrolling there.
    const rows = [
      ["a@example.com", "A", "", "Aa", "A", "", "Beginner", "Monday", "16:00", "weekly"],
      ["b@example.com", "B", "", "Bb", "B", "", "Beginner", "Monday", "16:00", "weekly"],
      ["c@example.com", "C", "", "Cc", "C", "", "Beginner", "Monday", "16:00", "weekly"],
    ];
    const report = await withTenant(
      { schoolId: SCHOOL_ID, userId: USER_ID },
      (tx) =>
        importRepository.dryRunImport(tx, {
          rows,
          headers: HEADERS,
          mapping: STD_MAPPING,
          resolutions: {},
        }),
    );
    expect(report.blocking).toBe(false);
    expect(
      report.findings.some(
        (f) => f.rule === "capacity_breach" && f.severity === "warning",
      ),
    ).toBe(true);
  });

  test("rule: duplicate_email within batch is blocking on the second occurrence", async () => {
    const rows = [
      ["d@example.com", "D Adult", "", "D1", "D", "", "Beginner", "Monday", "16:00", "weekly"],
      ["d@example.com", "D Adult", "", "D2", "D", "", "Beginner", "Monday", "16:00", "weekly"],
    ];
    const report = await withTenant(
      { schoolId: SCHOOL_ID, userId: USER_ID },
      (tx) =>
        importRepository.dryRunImport(tx, {
          rows,
          headers: HEADERS,
          mapping: STD_MAPPING,
          resolutions: {},
        }),
    );
    const dup = report.findings.find(
      (f) => f.row === 2 && f.rule === "duplicate_email",
    );
    expect(dup).toBeDefined();
    expect(report.blocking).toBe(true);
  });
});

describe("importRepository.commitImport + rollbackImport", () => {
  test("commit persists, rollback removes everything tagged with batch_id", async () => {
    const rows = [
      ["x@example.com", "X Adult", "0400", "X1", "X", "01/01/2018", "Beginner", "Monday", "16:00", "weekly"],
      ["y@example.com", "Y Adult", "0401", "Y1", "Y", "01/01/2019", "Intermediate", "Wednesday", "17:30", "weekly"],
    ];
    const commit = await withTenant(
      { schoolId: SCHOOL_ID, userId: USER_ID },
      (tx) =>
        importRepository.commitImport(tx, {
          rows,
          headers: HEADERS,
          mapping: STD_MAPPING,
          resolutions: {},
        }),
    );
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    expect(commit.result.familyCount).toBe(2);
    expect(commit.result.studentCount).toBe(2);
    expect(commit.result.enrolmentCount).toBe(2);

    const batchId = commit.result.batchId;
    const fam = await admin.family.count({ where: { batchId } });
    expect(fam).toBe(2);
    const stu = await admin.student.count({ where: { batchId } });
    expect(stu).toBe(2);

    // Rollback.
    const rb = await withTenant(
      { schoolId: SCHOOL_ID, userId: USER_ID },
      (tx) => importRepository.rollbackImport(tx, batchId),
    );
    expect(rb.alreadyRolledBack).toBe(false);
    expect(await admin.family.count({ where: { batchId } })).toBe(0);
    expect(await admin.student.count({ where: { batchId } })).toBe(0);
    expect(await admin.enrolment.count({ where: { batchId } })).toBe(0);
    const batch = await admin.importBatch.findUnique({ where: { id: batchId } });
    expect(batch?.rolledBackAt).not.toBeNull();
  });

  test("rollback is idempotent — second call sets alreadyRolledBack=true", async () => {
    const commit = await withTenant(
      { schoolId: SCHOOL_ID, userId: USER_ID },
      (tx) =>
        importRepository.commitImport(tx, {
          rows: [
            ["z@example.com", "Z", "", "Zz", "Z", "", "Beginner", "Monday", "16:00", "weekly"],
          ],
          headers: HEADERS,
          mapping: STD_MAPPING,
          resolutions: {},
        }),
    );
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    const id = commit.result.batchId;
    await withTenant({ schoolId: SCHOOL_ID, userId: USER_ID }, (tx) =>
      importRepository.rollbackImport(tx, id),
    );
    const second = await withTenant(
      { schoolId: SCHOOL_ID, userId: USER_ID },
      (tx) => importRepository.rollbackImport(tx, id),
    );
    expect(second.alreadyRolledBack).toBe(true);
  });

  test("commit refuses when re-validation finds blocking errors", async () => {
    // Forge a row missing email — repo should return ok=false report, no batch row.
    const commit = await withTenant(
      { schoolId: SCHOOL_ID, userId: USER_ID },
      (tx) =>
        importRepository.commitImport(tx, {
          rows: [
            ["", "X", "", "X1", "X", "", "Beginner", "Monday", "16:00", "weekly"],
          ],
          headers: HEADERS,
          mapping: STD_MAPPING,
          resolutions: {},
        }),
    );
    expect(commit.ok).toBe(false);
    if (commit.ok) return;
    expect(commit.report.blocking).toBe(true);
    const batches = await admin.importBatch.count();
    expect(batches).toBe(0);
  });

  test("listCommitted excludes rolled-back batches; countCommitted matches", async () => {
    const c1 = await withTenant({ schoolId: SCHOOL_ID, userId: USER_ID }, (tx) =>
      importRepository.commitImport(tx, {
        rows: [["a@example.com", "A", "", "A1", "A", "", "", "", "", ""]],
        headers: HEADERS,
        mapping: STD_MAPPING,
        resolutions: {},
      }),
    );
    expect(c1.ok).toBe(true);
    if (!c1.ok) return;
    const c2 = await withTenant({ schoolId: SCHOOL_ID, userId: USER_ID }, (tx) =>
      importRepository.commitImport(tx, {
        rows: [["b@example.com", "B", "", "B1", "B", "", "", "", "", ""]],
        headers: HEADERS,
        mapping: STD_MAPPING,
        resolutions: {},
      }),
    );
    expect(c2.ok).toBe(true);
    if (!c2.ok) return;
    await withTenant({ schoolId: SCHOOL_ID, userId: USER_ID }, (tx) =>
      importRepository.rollbackImport(tx, c1.result.batchId),
    );
    const list = await withTenant(
      { schoolId: SCHOOL_ID, userId: USER_ID },
      (tx) => importRepository.listCommitted(tx),
    );
    expect(list.map((b) => b.id)).toEqual([c2.result.batchId]);
    const count = await withTenant(
      { schoolId: SCHOOL_ID, userId: USER_ID },
      (tx) => importRepository.countCommitted(tx),
    );
    expect(count).toBe(1);
  });
});
