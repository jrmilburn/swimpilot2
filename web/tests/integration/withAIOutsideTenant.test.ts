import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock("../../src/ai/client", () => ({
  anthropic: {
    messages: { create: mockCreate },
  },
}));

import { prisma } from "../../src/lib/db/client";
import { withAI, MissingTenantContextError } from "../../src/ai/withAI";
import { familySummary } from "../../src/ai/prompts/system/family-summary";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

beforeAll(async () => {
  await admin.$executeRawUnsafe(`TRUNCATE ai_calls RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("withAI: outside a tenant context", () => {
  test("throws MissingTenantContextError without calling the SDK or writing a row", async () => {
    await expect(
      withAI({
        feature: "system.family_summary",
        prompt: familySummary,
        input: {
          primaryContactName: "Jane",
          studentCount: 1,
          studentFirstNames: ["Ada"],
        },
      }),
    ).rejects.toBeInstanceOf(MissingTenantContextError);

    expect(mockCreate).not.toHaveBeenCalled();

    const rows = await admin.aiCall.findMany();
    expect(rows.length).toBe(0);
  });
});
