import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import * as skillRepository from "../../src/repositories/skillRepository";
import { ValidationError } from "../../src/lib/errors";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const LEVEL_A = "eeeeeee0-0000-0000-0000-00000000000a";
const LEVEL_A2 = "eeeeeee0-0000-0000-0000-00000000000c";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, class_levels, skills, student_skills RESTART IDENTITY CASCADE`,
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
  await admin.$executeRaw`
    INSERT INTO class_levels (id, school_id, name, ratio, order_index, created_by, updated_by, updated_at) VALUES
      (${LEVEL_A}::uuid, ${SCHOOL_A}::uuid, 'Beginner', 6, 0, ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${LEVEL_A2}::uuid, ${SCHOOL_A}::uuid, 'Intermediate', 8, 1, ${USER_A}::uuid, ${USER_A}::uuid, now())
  `;
});

beforeEach(async () => {
  await admin.$executeRawUnsafe(`DELETE FROM skills`);
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("skillRepository unique-violation mapping", () => {
  test("create with a duplicate name under the same level throws ValidationError keyed against `name`", async () => {
    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
      skillRepository.create(tx, {
        levelId: LEVEL_A,
        name: "Streamline",
        orderIndex: 0,
      }),
    );

    let caught: unknown;
    try {
      await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        skillRepository.create(tx, {
          levelId: LEVEL_A,
          name: "Streamline",
          orderIndex: 1,
        }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    const ve = caught as ValidationError;
    expect(ve.fieldErrors?.name).toMatch(/already exists/i);
  });

  test("same name under a different level is allowed", async () => {
    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, async (tx) => {
      await skillRepository.create(tx, {
        levelId: LEVEL_A,
        name: "Streamline",
        orderIndex: 0,
      });
      const second = await skillRepository.create(tx, {
        levelId: LEVEL_A2,
        name: "Streamline",
        orderIndex: 0,
      });
      expect(second.levelId).toBe(LEVEL_A2);
      expect(second.name).toBe("Streamline");
    });
  });

  test("renaming via update to a sibling's name throws ValidationError keyed against `name`", async () => {
    const { aId } = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      async (tx) => {
        const a = await skillRepository.create(tx, {
          levelId: LEVEL_A,
          name: "Streamline",
          orderIndex: 0,
        });
        await skillRepository.create(tx, {
          levelId: LEVEL_A,
          name: "Glide",
          orderIndex: 1,
        });
        return { aId: a.id };
      },
    );

    let caught: unknown;
    try {
      await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, (tx) =>
        skillRepository.update(tx, aId, { name: "Glide" }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    const ve = caught as ValidationError;
    expect(ve.fieldErrors?.name).toMatch(/already exists/i);
  });
});
