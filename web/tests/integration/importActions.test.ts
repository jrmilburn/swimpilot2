import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { PrismaClient } from "@prisma/client";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??=
  "pk_test_dGVzdC10ZXN0LXRlc3QudGVzdC50ZXN0LWlu";
process.env.CLERK_SECRET_KEY ??= "sk_test_dGVzdC10ZXN0LXRlc3QtdGVzdA";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
}));

const headerStore: { current: Headers } = { current: new Headers() };
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => headerStore.current),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { auth } from "@clerk/nextjs/server";
import { prisma } from "../../src/lib/db/client";
import { parseCsvAction } from "../../src/app/s/[schoolSlug]/onboarding/import/_actions/parseCsv";
import { dryRunImportAction } from "../../src/app/s/[schoolSlug]/onboarding/import/_actions/dryRunImport";
import { commitImportAction } from "../../src/app/s/[schoolSlug]/onboarding/import/_actions/commitImport";
import { rollbackImportAction } from "../../src/app/s/[schoolSlug]/onboarding/import/_actions/rollbackImport";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CLERK_ID = "user_solo_test";
const LOCATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-00000000000a";
const LEVEL_ID = "eeeeeeee-eeee-4eee-8eee-00000000000a";
const CLASS_ID = "11111111-aaaa-4aaa-8aaa-000000000001";

async function seed() {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations, class_levels, classes,
     families, students, enrolments, import_batches RESTART IDENTITY CASCADE`,
  );
  await admin.$executeRaw`
    INSERT INTO users (id, clerk_id, email, name, updated_at) VALUES
      (${USER_ID}::uuid, ${CLERK_ID}, 'u@example.com', 'U', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${SCHOOL_ID}::uuid, 'riverside', 'R', 'Australia/Sydney', 'AUD', ${USER_ID}::uuid, ${USER_ID}::uuid, now())
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
      (${LEVEL_ID}::uuid, ${SCHOOL_ID}::uuid, 'Beginner', 4, 0, ${USER_ID}::uuid, ${USER_ID}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO classes (id, school_id, location_id, level_id, day_of_week, start_time, duration_minutes, capacity, status, created_by, updated_by, updated_at) VALUES
      (${CLASS_ID}::uuid, ${SCHOOL_ID}::uuid, ${LOCATION_ID}::uuid, ${LEVEL_ID}::uuid, 'monday', '16:00:00'::time, 30, 4, 'active', ${USER_ID}::uuid, ${USER_ID}::uuid, now())
  `;
}

beforeAll(seed);

beforeEach(async () => {
  vi.mocked(auth).mockReset();
  vi.mocked(auth).mockResolvedValue({ userId: CLERK_ID } as never);
  headerStore.current = new Headers({ "x-school-slug": "riverside" });
  await admin.$executeRawUnsafe(
    `TRUNCATE families, students, enrolments, import_batches RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

const HEADERS = ["email", "first", "last", "level", "day", "time", "frequency"];
const MAPPING = {
  email: "family.primary_contact_email",
  first: "student.first_name",
  last: "student.last_name",
  level: "enrolment.level_name",
  day: "enrolment.day",
  time: "enrolment.time",
  frequency: "enrolment.frequency",
} as const;

describe("parseCsvAction", () => {
  test("parses headers + rows, strips UTF-8 BOM", async () => {
    const csv = "\uFEFFa,b,c\n1,2,3\n4,5,6\n";
    const r = await parseCsvAction({ csvText: csv });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.headers).toEqual(["a", "b", "c"]);
    expect(r.data.rows).toEqual([["1", "2", "3"], ["4", "5", "6"]]);
  });

  test("rejects > 1000 rows", async () => {
    const lines = ["a,b"];
    for (let i = 0; i < 1001; i++) lines.push(`${i},${i}`);
    const r = await parseCsvAction({ csvText: lines.join("\n") });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("VALIDATION");
    expect(r.error.message).toMatch(/1000/);
  });

  test("rejects > 1 MB byte input", async () => {
    const big = "a,b\n" + "x,".repeat(600_000);
    const r = await parseCsvAction({ csvText: big });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("VALIDATION");
  });

  test("empty input rejected", async () => {
    const r = await parseCsvAction({ csvText: "" });
    expect(r.ok).toBe(false);
  });
});

describe("dryRunImportAction", () => {
  test("returns blocking report when required column unmapped", async () => {
    // Map nothing — no email column, every row missing required.
    const r = await dryRunImportAction({
      headers: HEADERS,
      rows: [["a@example.com", "A", "A", "Beginner", "Monday", "16:00", "weekly"]],
      mapping: { email: "ignore", first: "ignore", last: "ignore", level: "ignore", day: "ignore", time: "ignore", frequency: "ignore" },
      resolutions: {},
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.blocking).toBe(true);
  });

  test("happy report with no findings", async () => {
    const r = await dryRunImportAction({
      headers: HEADERS,
      rows: [["x@example.com", "X", "X", "Beginner", "Monday", "16:00", "weekly"]],
      mapping: MAPPING,
      resolutions: {},
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.blocking).toBe(false);
    expect(r.data.preview.familyCount).toBe(1);
  });
});

describe("commitImportAction + rollbackImportAction", () => {
  test("commit then rollback round-trip via the action layer", async () => {
    const c = await commitImportAction({
      headers: HEADERS,
      rows: [["x@example.com", "X", "X", "Beginner", "Monday", "16:00", "weekly"]],
      mapping: MAPPING,
      resolutions: {},
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const data = c.data;
    if (!data.ok) throw new Error("expected commit to succeed");
    const batchId = data.result.batchId;

    expect(await admin.family.count({ where: { batchId } })).toBe(1);

    const rb = await rollbackImportAction({ batchId });
    expect(rb.ok).toBe(true);
    if (!rb.ok) return;
    expect(rb.data.alreadyRolledBack).toBe(false);
    expect(await admin.family.count({ where: { batchId } })).toBe(0);
  });

  test("rollback of unknown batch surfaces NOT_FOUND", async () => {
    const r = await rollbackImportAction({
      batchId: "00000000-0000-0000-0000-000000000000",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("NOT_FOUND");
  });
});
