import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";

import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as importRepository from "../../src/repositories/importRepository";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const SCHOOL_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const USER_B = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const BATCH_B = "99999999-aaaa-4aaa-8aaa-00000000000b";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, import_batches RESTART IDENTITY CASCADE`,
  );
  await admin.$executeRaw`
    INSERT INTO users (id, email, name, updated_at) VALUES
      (${USER_A}::uuid, 'a@example.com', 'A', now()),
      (${USER_B}::uuid, 'b@example.com', 'B', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${SCHOOL_A}::uuid, 'school-a', 'A', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${SCHOOL_B}::uuid, 'school-b', 'B', 'Australia/Sydney', 'AUD', ${USER_B}::uuid, ${USER_B}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${USER_A}::uuid, 'owner', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (gen_random_uuid(), ${SCHOOL_B}::uuid, ${USER_B}::uuid, 'owner', ${USER_B}::uuid, ${USER_B}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO import_batches (
      id, school_id, mapping, row_count, family_count, student_count,
      enrolment_count, committed_at, created_by, updated_by, updated_at
    ) VALUES (
      ${BATCH_B}::uuid, ${SCHOOL_B}::uuid, '{}'::jsonb, 0, 0, 0, 0,
      now(), ${USER_B}::uuid, ${USER_B}::uuid, now()
    )
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("import_batches: cross-tenant isolation under RLS", () => {
  test("scoped to A: getById of B's batch returns null", async () => {
    const found = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => importRepository.getById(tx, BATCH_B),
    );
    expect(found).toBeNull();
  });

  test("scoped to A: listCommitted excludes B's batch", async () => {
    const rows = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => importRepository.listCommitted(tx),
    );
    expect(rows.find((r) => r.id === BATCH_B)).toBeUndefined();
    expect(rows.every((r) => r.schoolId === SCHOOL_A)).toBe(true);
  });

  test("scoped to A: countCommitted does not see B's batch", async () => {
    const c = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => importRepository.countCommitted(tx),
    );
    expect(c).toBe(0);
  });

  test("scoped to A: WITH CHECK blocks insert with school_id=B", async () => {
    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        tx.$executeRaw`
          INSERT INTO import_batches (
            id, school_id, mapping, row_count, family_count, student_count,
            enrolment_count, committed_at, created_by, updated_by, updated_at
          ) VALUES (
            gen_random_uuid(), ${SCHOOL_B}::uuid, '{}'::jsonb, 0, 0, 0, 0,
            now(), ${USER_A}::uuid, ${USER_A}::uuid, now()
          )
        `,
      ),
    ).rejects.toThrow();
  });
});
