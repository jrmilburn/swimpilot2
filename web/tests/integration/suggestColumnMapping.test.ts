import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { PrismaClient } from "@prisma/client";

// Action-layer behavioural cases for the AI column-mapping suggestion.
// The action wraps `withAI`; we mock the Anthropic SDK client at the
// module boundary so this test never spends real money or depends on a
// network round-trip.
//
// Clerk env vars must exist at module-init time. Placeholder values match
// the other integration tests in this folder.
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??=
  "pk_test_dGVzdC10ZXN0LXRlc3QudGVzdC50ZXN0LWlu";
process.env.CLERK_SECRET_KEY ??= "sk_test_dGVzdC10ZXN0LXRlc3QtdGVzdA";

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock("../../src/ai/client", () => ({
  anthropic: {
    messages: { create: mockCreate },
  },
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
}));

const headerStore: { current: Headers } = { current: new Headers() };
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => headerStore.current),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { auth } from "@clerk/nextjs/server";
import { prisma } from "../../src/lib/db/client";
import { suggestColumnMapping } from "../../src/app/s/[schoolSlug]/onboarding/import/_actions/suggestColumnMapping";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const USER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CLERK_A = "user_test_a";
const SLUG = "school-a";

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, ai_calls RESTART IDENTITY CASCADE`,
  );
  await admin.$executeRaw`
    INSERT INTO users (id, clerk_id, email, name, updated_at) VALUES
      (${USER_A}::uuid, ${CLERK_A}, 'a@example.com', 'User A', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${SCHOOL_A}::uuid, ${SLUG}, 'School A', 'Australia/Sydney', 'AUD', ${USER_A}::uuid, ${USER_A}::uuid, now())
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
  vi.mocked(auth).mockResolvedValue({ userId: CLERK_A } as never);
  headerStore.current = new Headers({ "x-school-slug": SLUG });
  await admin.$executeRawUnsafe(`TRUNCATE ai_calls RESTART IDENTITY CASCADE`);
});

function unwrap<T>(
  result:
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string } },
): T {
  if (!result.ok) {
    throw new Error(
      `expected ok=true, got error ${result.error.code}: ${result.error.message}`,
    );
  }
  return result.data;
}

function modelTextResponse(text: string) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: "claude-haiku-4-5",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

const HEADERS = ["Email", "First Name", "DOB"];
const ROWS = [
  ["jane@example.com", "Ada", "2017-04-09"],
  ["jane@example.com", "Grace", "2019-12-01"],
];

describe("suggestColumnMapping", () => {
  test("happy path returns ok=true with a valid mapping and writes ai_calls", async () => {
    mockCreate.mockResolvedValueOnce(
      modelTextResponse(
        JSON.stringify({
          mapping: {
            Email: "family.primary_contact_email",
            "First Name": "student.first_name",
            DOB: "student.date_of_birth",
          },
          confidence: {
            Email: "high",
            "First Name": "high",
            DOB: "medium",
          },
        }),
      ),
    );

    const data = unwrap(
      await suggestColumnMapping({ headers: HEADERS, sampleRows: ROWS }),
    );
    expect(data.ok).toBe(true);
    if (!data.ok) return;
    expect(data.mapping).toEqual({
      Email: "family.primary_contact_email",
      "First Name": "student.first_name",
      DOB: "student.date_of_birth",
    });
    expect(data.confidence.Email).toBe("high");

    const rows = await admin.aiCall.findMany();
    expect(rows.length).toBe(1);
    expect(rows[0].feature).toBe("onboarding-csv-map");
    expect(rows[0].promptName).toBe("csv-column-map");
    expect(rows[0].status).toBe("ok");
    expect(rows[0].inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].schoolId).toBe(SCHOOL_A);
  });

  test("strips ```json code fences if the model adds them anyway", async () => {
    mockCreate.mockResolvedValueOnce(
      modelTextResponse(
        "```json\n" +
          JSON.stringify({
            mapping: {
              Email: "family.primary_contact_email",
              "First Name": "student.first_name",
              DOB: "student.date_of_birth",
            },
            confidence: {
              Email: "high",
              "First Name": "high",
              DOB: "high",
            },
          }) +
          "\n```",
      ),
    );

    const data = unwrap(
      await suggestColumnMapping({ headers: HEADERS, sampleRows: ROWS }),
    );
    expect(data.ok).toBe(true);
  });

  test("withAI throws → ok=false ai_unavailable; no exception bubbles up", async () => {
    mockCreate.mockRejectedValueOnce(new Error("upstream went sideways"));

    const data = unwrap(
      await suggestColumnMapping({ headers: HEADERS, sampleRows: ROWS }),
    );
    expect(data.ok).toBe(false);
    if (data.ok) return;
    expect(data.reason).toBe("ai_unavailable");

    // withAI still wrote the error row — even though our wrapper swallowed
    // the error for the operator, the audit trail records the call.
    const rows = await admin.aiCall.findMany();
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("error");
    expect(rows[0].feature).toBe("onboarding-csv-map");
  });

  test("invalid JSON → ok=false invalid_response", async () => {
    mockCreate.mockResolvedValueOnce(
      modelTextResponse("this is not JSON at all, sorry"),
    );

    const data = unwrap(
      await suggestColumnMapping({ headers: HEADERS, sampleRows: ROWS }),
    );
    expect(data.ok).toBe(false);
    if (data.ok) return;
    expect(data.reason).toBe("invalid_response");
  });

  test("response with target outside the allowed set → ok=false invalid_response", async () => {
    mockCreate.mockResolvedValueOnce(
      modelTextResponse(
        JSON.stringify({
          mapping: {
            Email: "family.imaginary_field",
            "First Name": "student.first_name",
            DOB: null,
          },
          confidence: {
            Email: "high",
            "First Name": "high",
            DOB: "low",
          },
        }),
      ),
    );

    const data = unwrap(
      await suggestColumnMapping({ headers: HEADERS, sampleRows: ROWS }),
    );
    expect(data.ok).toBe(false);
    if (data.ok) return;
    expect(data.reason).toBe("invalid_response");
  });

  test("all-low-confidence response → ok=false low_confidence", async () => {
    mockCreate.mockResolvedValueOnce(
      modelTextResponse(
        JSON.stringify({
          mapping: { Email: null, "First Name": null, DOB: null },
          confidence: {
            Email: "low",
            "First Name": "low",
            DOB: "low",
          },
        }),
      ),
    );

    const data = unwrap(
      await suggestColumnMapping({ headers: HEADERS, sampleRows: ROWS }),
    );
    expect(data.ok).toBe(false);
    if (data.ok) return;
    expect(data.reason).toBe("low_confidence");
  });
});
