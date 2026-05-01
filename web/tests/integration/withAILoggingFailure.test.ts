import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
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

afterEach(() => {
  vi.restoreAllMocks();
  mockCreate.mockReset();
});

describe("withAI: best-effort logging", () => {
  test("a logging failure does not break a successful SDK call", async () => {
    mockCreate.mockResolvedValueOnce({
      id: "msg_logging_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: "claude-haiku-4-5",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    // The wrapper's `withAI` opens its own short transaction via
    // `prisma.$transaction` to write the log row. The outer `withTenant`
    // uses the same singleton's `$transaction`. We selectively make ONLY
    // the log-write transaction fail by counting calls: the first
    // $transaction call belongs to withTenant, the second is the log write.
    const original = prisma.$transaction.bind(prisma);
    let calls = 0;
    const spy = vi
      .spyOn(prisma, "$transaction")
      .mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (...args: any[]): any => {
          calls += 1;
          if (calls === 2) {
            return Promise.reject(new Error("simulated logging failure"));
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (original as any)(...args);
        },
      );

    // Suppress the expected console.error from the best-effort log path.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await withTenant(
      { schoolId: SCHOOL_A, userId: USER_A },
      () =>
        withAI({
          feature: "system.family_summary",
          prompt: familySummary,
          input: {
            primaryContactName: "Jane",
            studentCount: 1,
            studentFirstNames: ["Ada"],
          },
        }),
    );

    expect(response.id).toBe("msg_logging_test");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalled();
  });
});
