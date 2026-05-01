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
const SCHOOL_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const USER_B = "dddddddd-dddd-dddd-dddd-dddddddddddd";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, ai_calls RESTART IDENTITY CASCADE`,
  );
  await admin.$executeRaw`
    INSERT INTO users (id, email, name, updated_at) VALUES
      (${USER_A}::uuid, 'a@example.com', 'User A', now()),
      (${USER_B}::uuid, 'b@example.com', 'User B', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${SCHOOL_A}::uuid, 'school-a', 'School A', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (${SCHOOL_B}::uuid, 'school-b', 'School B', 'Australia/Sydney', 'AUD', ${USER_B}::uuid, ${USER_B}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${SCHOOL_A}::uuid, ${USER_A}::uuid, 'owner', ${USER_A}::uuid, ${USER_A}::uuid, now()),
      (gen_random_uuid(), ${SCHOOL_B}::uuid, ${USER_B}::uuid, 'owner', ${USER_B}::uuid, ${USER_B}::uuid, now())
  `;
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

beforeEach(async () => {
  mockCreate.mockReset();
  await admin.$executeRawUnsafe(`TRUNCATE ai_calls RESTART IDENTITY CASCADE`);

  mockCreate.mockResolvedValue({
    id: "msg_x",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    model: "claude-haiku-4-5",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
});

describe("ai_calls: RLS isolation", () => {
  test("tenant A cannot see tenant B's ai_calls rows", async () => {
    // Make one call as each tenant.
    await withTenant({ schoolId: SCHOOL_A, userId: USER_A }, () =>
      withAI({
        feature: "system.family_summary",
        prompt: familySummary,
        input: { primaryContactName: "A", studentCount: 1, studentFirstNames: ["A"] },
      }),
    );
    await withTenant({ schoolId: SCHOOL_B, userId: USER_B }, () =>
      withAI({
        feature: "system.family_summary",
        prompt: familySummary,
        input: { primaryContactName: "B", studentCount: 1, studentFirstNames: ["B"] },
      }),
    );

    // Admin sees both rows.
    const all = await admin.aiCall.findMany();
    expect(all.length).toBe(2);

    // Inside tenant A's context, only A's row is visible.
    const seenByA = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      (tx) => tx.aiCall.findMany(),
    );
    expect(seenByA.length).toBe(1);
    expect(seenByA[0].schoolId).toBe(SCHOOL_A);

    // Inside tenant B's context, only B's row is visible.
    const seenByB = await withTenant(
      { schoolId: SCHOOL_B, userId: USER_B },
      (tx) => tx.aiCall.findMany(),
    );
    expect(seenByB.length).toBe(1);
    expect(seenByB[0].schoolId).toBe(SCHOOL_B);
  });
});
