import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as studentRepository from "../../src/repositories/studentRepository";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const SCHOOL_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const FAMILY_B = "ddddddd0-0000-0000-0000-000000000001";
const STUDENT_B = "eeeeeee0-0000-0000-0000-000000000001";

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
      (${SCHOOL_A}::uuid, 'school-a', 'School A', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${SCHOOL_B}::uuid, 'school-b', 'School B', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${USER_A}::uuid, 'owner', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO families (id, school_id, primary_contact_name, primary_contact_email, created_by, updated_by, updated_at) VALUES
      (${FAMILY_B}::uuid, ${SCHOOL_B}::uuid, 'Tenant B Family', 'b@example.com', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO students (id, school_id, family_id, first_name, last_name, date_of_birth, created_by, updated_by, updated_at) VALUES
      (${STUDENT_B}::uuid, ${SCHOOL_B}::uuid, ${FAMILY_B}::uuid, 'Mia', 'B', '2018-01-01', ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("students: cross-tenant isolation under RLS", () => {
  test("scoped to A: getById of B's student returns null", async () => {
    const found = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => studentRepository.getById(tx, STUDENT_B),
    );
    expect(found).toBeNull();
  });

  test("scoped to A: listBySchool returns no B rows", async () => {
    const page = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => studentRepository.listBySchool(tx),
    );
    expect(page.items.find((s) => s.id === STUDENT_B)).toBeUndefined();
    expect(page.items.every((s) => s.schoolId === SCHOOL_A)).toBe(true);
  });

  test("scoped to A: listByFamily on B's family returns nothing", async () => {
    const list = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => studentRepository.listByFamily(tx, FAMILY_B),
    );
    expect(list).toHaveLength(0);
  });

  test("scoped to A: direct INSERT with school_id = B is blocked by WITH CHECK", async () => {
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        tx.student.create({
          data: {
            schoolId: SCHOOL_B,
            familyId: FAMILY_B,
            firstName: "Cross",
            lastName: "Tenant",
            dateOfBirth: new Date("2018-01-01"),
            createdBy: USER_A,
            updatedBy: USER_A,
          },
        }),
      ),
    ).rejects.toThrow();

    const rowsB = await admin.student.findMany({ where: { schoolId: SCHOOL_B } });
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]?.id).toBe(STUDENT_B);
  });

  test("scoped to A: studentRepository.create against B's family throws (RLS hides the family)", async () => {
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        studentRepository.create(tx, {
          familyId: FAMILY_B,
          firstName: "Sneaky",
          lastName: "Insert",
          dateOfBirth: new Date("2019-01-01"),
        }),
      ),
    ).rejects.toThrow(/family .* not found/);
  });
});
