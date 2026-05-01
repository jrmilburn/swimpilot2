import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

// Mock the Anthropic SDK singleton before importing withAI. We don't want
// integration tests to spend real money or to depend on a network round
// trip — the smoke endpoint is the only thing that hits the real SDK.
//
// vi.mock is hoisted to the top of the file, so the factory cannot close
// over a normal `const`. vi.hoisted is the supported shape for that.
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

describe("withAI: happy path", () => {
  test("writes a row to ai_calls with the right tenant and prompt metadata", async () => {
    mockCreate.mockResolvedValueOnce({
      id: "msg_test_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Test family with two kids." }],
      model: "claude-haiku-4-5",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 42, output_tokens: 17 },
    });

    const response = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      () =>
        withAI({
          feature: "system.family_summary",
          prompt: familySummary,
          input: {
            primaryContactName: "Jane",
            studentCount: 2,
            studentFirstNames: ["Ada", "Grace"],
          },
        }),
    );

    expect(response.id).toBe("msg_test_1");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({
      model: "claude-haiku-4-5",
      max_tokens: 100,
    });

    const rows = await admin.aiCall.findMany();
    expect(rows.length).toBe(1);
    const row = rows[0];

    expect(row.schoolId).toBe(SCHOOL_A);
    expect(row.userId).toBe(USER_A);
    expect(row.feature).toBe("system.family_summary");
    expect(row.promptName).toBe("family-summary");
    expect(row.promptVersion).toBe(1);
    expect(row.model).toBe("claude-haiku-4-5");
    expect(row.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.inputTokens).toBe(42);
    expect(row.outputTokens).toBe(17);
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
    expect(row.status).toBe("ok");
    expect(row.errorMessage).toBeNull();
    expect(row.createdBy).toBe(USER_A);
    expect(row.updatedBy).toBe(USER_A);
  });
});
