import { Webhook, WebhookVerificationError } from "svix";
import { upsertFromClerk } from "@/repositories/userRepository";

type ClerkEmailAddress = {
  id: string;
  email_address: string;
};

type ClerkUserData = {
  id: string;
  email_addresses?: ClerkEmailAddress[];
  primary_email_address_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
};

type ClerkEvent = {
  type: string;
  data: ClerkUserData;
};

function pickEmail(data: ClerkUserData): string | null {
  const addrs = data.email_addresses ?? [];
  if (addrs.length === 0) return null;
  const primary = addrs.find((a) => a.id === data.primary_email_address_id);
  return (primary ?? addrs[0]).email_address;
}

function pickName(data: ClerkUserData): string {
  const parts = [data.first_name, data.last_name].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  if (parts.length > 0) return parts.join(" ");
  if (data.username) return data.username;
  return "";
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  if (!secret) {
    // Fail loudly: silently accepting unsigned webhooks would let any caller
    // create users.
    throw new Error("CLERK_WEBHOOK_SIGNING_SECRET is not set");
  }

  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return new Response("Missing svix headers", { status: 400 });
  }

  const rawBody = await req.text();

  const wh = new Webhook(secret);
  let event: ClerkEvent;
  try {
    event = wh.verify(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ClerkEvent;
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return new Response("Invalid signature", { status: 400 });
    }
    throw err;
  }

  if (event.type === "user.created" || event.type === "user.updated") {
    const email = pickEmail(event.data);
    if (!email) {
      return new Response("User has no email address", { status: 400 });
    }
    await upsertFromClerk({
      clerkId: event.data.id,
      email,
      name: pickName(event.data),
    });
  }

  return new Response("ok", { status: 200 });
}
