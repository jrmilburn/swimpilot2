import { NextResponse } from "next/server";

import { withAI } from "@/ai/withAI";
import { familySummary } from "@/ai/prompts/system/family-summary";
import { withTenant } from "@/lib/db/withTenant";
import { resolveSession } from "@/lib/auth/session";

// /api/ai/smoke — proves the full pathway works end-to-end. Hitting this in
// dev should: enter a tenant context, call Claude with the example prompt,
// and write a row to ai_calls. It is gated behind a non-production env
// check so it can never accidentally ship to a real environment.
//
// Auth is the stub `resolveSession` (x-user-id / x-school-id headers) —
// production AI features will use the real auth flow once it lands. The
// stub is enough to exercise AsyncLocalStorage propagation through the
// route handler → withTenant → withAI boundary, which is the load-bearing
// thing we want to verify.

export async function POST(): Promise<Response> {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let session;
  try {
    session = await resolveSession();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }

  const message = await withTenant(session, async () => {
    return withAI({
      feature: "system.family_summary",
      prompt: familySummary,
      input: {
        primaryContactName: "Test Family",
        studentCount: 2,
        studentFirstNames: ["Ada", "Grace"],
      },
    });
  });

  const text = message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");

  return NextResponse.json({
    id: message.id,
    model: message.model,
    text,
    usage: message.usage,
  });
}
