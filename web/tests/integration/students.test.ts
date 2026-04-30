import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as familyRepository from "../../src/repositories/familyRepository";
import * as studentRepository from "../../src/repositories/studentRepository";
import { StudentStatus } from "../../src/domain/enums";

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

describe("studentRepository", () => {
  test("create two students under one family, listByFamily returns both", async () => {
    const result = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      async (tx) => {
        const family = await familyRepository.create(tx, {
          primaryContactName: "Jordan Smith",
          primaryContactEmail: "jordan@example.com",
        });

        const a = await studentRepository.create(tx, {
          familyId: family.id,
          firstName: "Mia",
          lastName: "Smith",
          dateOfBirth: new Date("2018-03-12"),
        });
        const b = await studentRepository.create(tx, {
          familyId: family.id,
          firstName: "Leo",
          lastName: "Smith",
          dateOfBirth: new Date("2020-08-04"),
        });

        const list = await studentRepository.listByFamily(tx, family.id);
        return { family, a, b, list };
      },
    );

    expect(result.list.map((s) => s.id).sort()).toEqual(
      [result.a.id, result.b.id].sort(),
    );
    expect(result.a.schoolId).toBe(SCHOOL_A);
    expect(result.a.familyId).toBe(result.family.id);

    // Audit fields stamped via admin lookup.
    const row = await admin.student.findUnique({ where: { id: result.a.id } });
    expect(row?.createdBy).toBe(USER_A);
    expect(row?.updatedBy).toBe(USER_A);
  });

  test("status transitions: active -> paused -> withdrawn", async () => {
    const student = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      async (tx) => {
        const family = await familyRepository.create(tx, {
          primaryContactName: "Riley Brown",
          primaryContactEmail: "riley@example.com",
        });
        return studentRepository.create(tx, {
          familyId: family.id,
          firstName: "Nina",
          lastName: "Brown",
          dateOfBirth: new Date("2017-06-01"),
        });
      },
    );
    expect(student.status).toBe(StudentStatus.Active);

    const paused = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        studentRepository.update(tx, student.id, {
          status: StudentStatus.Paused,
        }),
    );
    expect(paused.status).toBe(StudentStatus.Paused);

    const withdrawn = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        studentRepository.update(tx, student.id, {
          status: StudentStatus.Withdrawn,
        }),
    );
    expect(withdrawn.status).toBe(StudentStatus.Withdrawn);
  });

  test("getById returns null for unknown id under tenant context", async () => {
    const found = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) =>
        studentRepository.getById(
          tx,
          "00000000-0000-0000-0000-000000000099",
        ),
    );
    expect(found).toBeNull();
  });
});
