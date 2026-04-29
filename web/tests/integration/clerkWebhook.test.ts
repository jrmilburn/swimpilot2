import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { Webhook } from "svix";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/db/client";
import { POST } from "../../src/app/api/webhooks/clerk/route";

// POST reads CLERK_WEBHOOK_SIGNING_SECRET at request time, so setting it
// before invoking POST (rather than before import) is sufficient.
const SIGNING_SECRET = "whsec_dGVzdHNlY3JldHRlc3RzZWNyZXR0ZXN0c2VjcmV0MTI=";
process.env.CLERK_WEBHOOK_SIGNING_SECRET = SIGNING_SECRET;

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const wh = new Webhook(SIGNING_SECRET);

type ClerkUserPayload = {
  type: "user.created" | "user.updated" | string;
  data: {
    id: string;
    email_addresses: { id: string; email_address: string }[];
    primary_email_address_id: string;
    first_name: string | null;
    last_name: string | null;
  };
};

function makeSignedRequest(payload: unknown): Request {
  const body = JSON.stringify(payload);
  const msgId = `msg_${Math.random().toString(36).slice(2)}`;
  const timestamp = new Date();
  const signature = wh.sign(msgId, timestamp, body);

  return new Request("http://localhost/api/webhooks/clerk", {
    method: "POST",
    headers: {
      "svix-id": msgId,
      "svix-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
      "svix-signature": signature,
      "content-type": "application/json",
    },
    body,
  });
}

function userCreatedPayload(overrides: Partial<{
  clerkId: string;
  email: string;
  firstName: string;
  lastName: string;
  type: string;
}> = {}): ClerkUserPayload {
  const clerkId = overrides.clerkId ?? "user_2abcDEF12345";
  const email = overrides.email ?? "alice@example.com";
  return {
    type: overrides.type ?? "user.created",
    data: {
      id: clerkId,
      email_addresses: [{ id: "idn_1", email_address: email }],
      primary_email_address_id: "idn_1",
      first_name: overrides.firstName ?? "Alice",
      last_name: overrides.lastName ?? "Smith",
    },
  };
}

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations RESTART IDENTITY CASCADE`,
  );
});

beforeEach(async () => {
  await admin.$executeRawUnsafe(`TRUNCATE users RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("POST /api/webhooks/clerk", () => {
  test("user.created with valid signature inserts a user row", async () => {
    const res = await POST(makeSignedRequest(userCreatedPayload()));
    expect(res.status).toBe(200);

    const rows = await admin.user.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clerkId: "user_2abcDEF12345",
      email: "alice@example.com",
      name: "Alice Smith",
      createdBy: null,
      updatedBy: null,
    });
  });

  test("same user.created payload twice yields exactly one row", async () => {
    const payload = userCreatedPayload();
    const res1 = await POST(makeSignedRequest(payload));
    const res2 = await POST(makeSignedRequest(payload));
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const rows = await admin.user.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clerkId).toBe("user_2abcDEF12345");
  });

  test("user.updated changes email and name on the existing row", async () => {
    await POST(makeSignedRequest(userCreatedPayload()));

    const updated = userCreatedPayload({
      type: "user.updated",
      email: "alice.smith@example.com",
      firstName: "Alicia",
      lastName: "Smythe",
    });
    const res = await POST(makeSignedRequest(updated));
    expect(res.status).toBe(200);

    const rows = await admin.user.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clerkId: "user_2abcDEF12345",
      email: "alice.smith@example.com",
      name: "Alicia Smythe",
    });
  });

  test("invalid signature returns 400 and writes nothing", async () => {
    const body = JSON.stringify(userCreatedPayload());
    const req = new Request("http://localhost/api/webhooks/clerk", {
      method: "POST",
      headers: {
        "svix-id": "msg_bad",
        "svix-timestamp": Math.floor(Date.now() / 1000).toString(),
        "svix-signature": "v1,bogussignaturevalue",
        "content-type": "application/json",
      },
      body,
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const rows = await admin.user.findMany();
    expect(rows).toHaveLength(0);
  });

  test("unknown event type returns 200 and writes nothing", async () => {
    const res = await POST(
      makeSignedRequest({
        type: "session.created",
        data: { id: "sess_xyz" },
      }),
    );
    expect(res.status).toBe(200);

    const rows = await admin.user.findMany();
    expect(rows).toHaveLength(0);
  });
});
