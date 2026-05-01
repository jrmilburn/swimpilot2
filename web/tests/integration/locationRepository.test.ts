import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as locationRepository from "../../src/repositories/locationRepository";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const SCHOOL_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations, families, students,
       class_levels, classes, enrolments, class_sessions, attendance,
       skills, student_skills
     RESTART IDENTITY CASCADE`,
  );
  await admin.$executeRaw`
    INSERT INTO users (id, email, name, updated_at) VALUES
      (${USER_A}::uuid, 'a@example.com', 'User A', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${SCHOOL_A}::uuid, 'school-a', 'School A', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${SCHOOL_B}::uuid, 'school-b', 'School B', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${USER_A}::uuid, 'owner', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

beforeEach(async () => {
  await admin.$executeRawUnsafe(`DELETE FROM locations`);
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("locationRepository", () => {
  test("create + getById round-trips and stamps audit fields", async () => {
    const created = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        locationRepository.create(tx, {
          name: "Parramatta Pool",
          addressLine: "46 Park Pde",
          suburb: "Parramatta",
          state: "NSW",
          postcode: "2150",
          timezone: "Australia/Sydney",
          notes: "Indoor heated 25m",
        }),
    );

    expect(created.schoolId).toBe(SCHOOL_A);
    expect(created.name).toBe("Parramatta Pool");
    expect(created.addressLine).toBe("46 Park Pde");
    expect(created.suburb).toBe("Parramatta");
    expect(created.state).toBe("NSW");
    expect(created.postcode).toBe("2150");
    expect(created.timezone).toBe("Australia/Sydney");
    expect(created.notes).toBe("Indoor heated 25m");

    const fetched = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => locationRepository.getById(tx, created.id),
    );
    expect(fetched?.id).toBe(created.id);

    const row = await admin.location.findUnique({ where: { id: created.id } });
    expect(row?.createdBy).toBe(USER_A);
    expect(row?.updatedBy).toBe(USER_A);
  });

  test("update mutates fields and stamps updated_by", async () => {
    const created = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        locationRepository.create(tx, {
          name: "Ryde Aquatic",
          timezone: null,
        }),
    );

    const updated = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        locationRepository.update(tx, created.id, {
          addressLine: "504 Victoria Rd",
          suburb: "Ryde",
          state: "NSW",
          postcode: "2112",
        }),
    );
    expect(updated.addressLine).toBe("504 Victoria Rd");
    expect(updated.suburb).toBe("Ryde");
    expect(updated.timezone).toBeNull();

    const row = await admin.location.findUnique({ where: { id: created.id } });
    expect(row?.updatedBy).toBe(USER_A);
  });

  test("listBySchool filters soft-deleted by default; includeArchived returns them", async () => {
    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, async (tx) => {
      await locationRepository.create(tx, { name: "Alive 1" });
      await locationRepository.create(tx, { name: "Alive 2" });
      const archived = await locationRepository.create(tx, {
        name: "Archived",
      });
      await locationRepository.archive(tx, archived.id);
    });

    const visible = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => locationRepository.listBySchool(tx),
    );
    expect(visible.map((l) => l.name)).toEqual(["Alive 1", "Alive 2"]);

    const all = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => locationRepository.listBySchool(tx, { includeArchived: true }),
    );
    expect(all.map((l) => l.name)).toContain("Archived");
    expect(all).toHaveLength(3);
  });

  test("archive sets deletedAt; getById then returns null", async () => {
    const created = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => locationRepository.create(tx, { name: "Bondi Pavilion" }),
    );

    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
      locationRepository.archive(tx, created.id),
    );

    const fetched = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => locationRepository.getById(tx, created.id),
    );
    expect(fetched).toBeNull();

    const row = await admin.location.findUnique({ where: { id: created.id } });
    expect(row?.deletedAt).not.toBeNull();
  });

  test("RLS WITH CHECK rejects a direct create with a foreign school_id", async () => {
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        tx.location.create({
          data: {
            schoolId: SCHOOL_B,
            name: "Cross",
            createdBy: USER_A,
            updatedBy: USER_A,
          },
        }),
      ),
    ).rejects.toThrow();

    const rowsB = await admin.location.findMany({
      where: { schoolId: SCHOOL_B },
    });
    expect(rowsB).toHaveLength(0);
  });

  test("scoped to A: getById of B's location returns null", async () => {
    await admin.$executeRaw`
      INSERT INTO locations (id, school_id, name, created_by, updated_by, updated_at)
      VALUES (gen_random_uuid(), ${SCHOOL_B}::uuid, 'B-only',
              ${USER_A}::uuid, ${USER_A}::uuid, now())
    `;
    const bRow = await admin.location.findFirst({
      where: { schoolId: SCHOOL_B },
    });

    const found = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => locationRepository.getById(tx, bRow!.id),
    );
    expect(found).toBeNull();
  });
});
