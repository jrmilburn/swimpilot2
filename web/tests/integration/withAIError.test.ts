import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock("../../src/ai/client", () => ({
  anthropic: {
    messages: { create: mockCreate },
  },
}));

import { prisma } from "../../src/lib/db/client";
import { withTenant } from "../../src/lib/db/withTenant";
import { withAI } from "../../src/ai/withAI";
import { familySummary } from "../../src/ai/prompts/system/family-summary";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, ai_calls RESTART IDENTITY CASCADE`,
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

beforeEach(async () => {
  mockCreate.mockReset();
  await admin.$executeRawUnsafe(`TRUNCATE ai_calls RESTART IDENTITY CASCADE`);
});

describe("withAI: SDK errors", () => {
  test("re-throws the original error and writes a status='error' row", async () => {
    const sdkError = new Error("upstream went sideways");
    mockCreate.mockRejectedValueOnce(sdkError);

    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, () =>
        withAI({
          feature: "system.family_summary",
          prompt: familySummary,
          input: {
            primaryContactName: "Jane",
            studentCount: 1,
            studentFirstNames: ["Ada"],
          },
        }),
      ),
    ).rejects.toBe(sdkError);

    const rows = await admin.aiCall.findMany();
    expect(rows.length).toBe(1);
    const row = rows[0];

    expect(row.status).toBe("error");
    expect(row.errorMessage).toBe("upstream went sideways");
    expect(row.inputTokens).toBeNull();
    expect(row.outputTokens).toBeNull();
    expect(row.feature).toBe("system.family_summary");
    expect(row.schoolId).toBe(SCHOOL_A);
    expect(row.userId).toBe(USER_A);
  });

  test("truncates very long error messages to 1000 chars", async () => {
    const longMessage = "x".repeat(5000);
    mockCreate.mockRejectedValueOnce(new Error(longMessage));

    await expect(
      withTenant({ schoolId: SCHOOL_A, userId: USER_A }, () =>
        withAI({
          feature: "system.family_summary",
          prompt: familySummary,
          input: {
            primaryContactName: "Jane",
            studentCount: 1,
            studentFirstNames: ["Ada"],
          },
        }),
      ),
    ).rejects.toThrow();

    const rows = await admin.aiCall.findMany();
    expect(rows[0].errorMessage?.length).toBe(1000);
  });
});
