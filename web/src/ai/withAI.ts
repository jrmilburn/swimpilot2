import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { Prisma } from "@prisma/client";

import { prisma } from "../lib/db/client";
import { getActorId, getSchoolId, SYSTEM_USER_ID } from "../lib/db/context";

import { anthropic } from "./client";
import type { PromptModule } from "./types";

/**
 * The wrapper every AI feature goes through. Establishes:
 *
 *   1. Tenant context is required. We read schoolId and userId from
 *      AsyncLocalStorage (set up by `withTenant` upstream). If no schoolId
 *      is bound, we throw before touching the SDK — AI calls do not happen
 *      outside a tenant context.
 *   2. The prompt is materialised from a typed `PromptModule`, never inline.
 *   3. The input is hashed, not stored, before being sent to the SDK.
 *   4. Latency, token counts, and the input hash are written to `ai_calls`
 *      after the call returns. This is best-effort: if the log write itself
 *      fails, we swallow the error (with a console.error) and return the
 *      SDK response so a logging bug can never break a user-facing AI feature.
 *   5. The wrapper does not retry, stream, validate output, or cache.
 *      Sprint 5 / Sprint 10 will add those at the call sites that actually
 *      need them.
 *
 * The log write is intentionally outside any caller transaction. The
 * SDK call can be slow (multiple seconds), and holding an open Postgres
 * transaction for the duration would lock rows updated upstream by the
 * caller. Instead, we open a fresh short-lived transaction here, set the
 * tenant GUC inside it (so RLS passes), and insert.
 */

const ERROR_MESSAGE_LIMIT = 1000;

export class MissingTenantContextError extends Error {
  constructor() {
    super(
      "withAI() must be called inside a tenant context. " +
        "Open one with withTenant() or getTenantContext() first.",
    );
    this.name = "MissingTenantContextError";
  }
}

/**
 * SHA-256 hex digest of the JSON-serialised input. `JSON.stringify` is fine
 * for the simple shapes Sprint 3 needs — Sprint 5's CSV inputs may want a
 * stable-key stringifier so equivalent objects with different key orderings
 * collide. See sprint-3-chunk-6 handoff.
 */
export function hashInput(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

interface LogRowInput {
  schoolId: string;
  userId: string | null;
  feature: string;
  promptName: string;
  promptVersion: number;
  model: string;
  inputHash: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  status: "ok" | "error";
  errorMessage: string | null;
}

async function logCall(row: LogRowInput): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.school_id', ${row.schoolId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.user_id', ${row.userId ?? SYSTEM_USER_ID}, true)`;
      // The audit extension stamps createdBy/updatedBy from
      // AsyncLocalStorage, but Prisma's generated input types still
      // require them — cast through the boundary, same pattern as
      // every other repository in the codebase.
      const data = {
        schoolId: row.schoolId,
        userId: row.userId,
        feature: row.feature,
        promptName: row.promptName,
        promptVersion: row.promptVersion,
        model: row.model,
        inputHash: row.inputHash,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        latencyMs: row.latencyMs,
        status: row.status,
        errorMessage: row.errorMessage,
      } as unknown as Prisma.AiCallCreateInput;
      await tx.aiCall.create({ data });
    });
  } catch (err) {
    // Best-effort: a logging failure must not propagate to the caller.
    console.error("withAI: failed to write ai_calls row", err);
  }
}

export interface WithAIArgs<TInput> {
  feature: string;
  prompt: PromptModule<TInput>;
  input: TInput;
}

/**
 * Returns the SDK response unchanged. Typed as `Anthropic.Message` because
 * that is what `messages.create` resolves to without streaming. Future
 * streaming support will introduce a different overload.
 */
export async function withAI<TInput>(
  args: WithAIArgs<TInput>,
): Promise<Anthropic.Message> {
  const schoolId = getSchoolId();
  if (!schoolId) {
    throw new MissingTenantContextError();
  }

  const actorId = getActorId();
  const userId = actorId === SYSTEM_USER_ID ? null : actorId;

  const built = args.prompt.build(args.input);
  const inputHash = hashInput(args.input);
  const startedAt = Date.now();

  let response: Anthropic.Message;
  try {
    response = await anthropic.messages.create({
      model: built.model,
      max_tokens: built.maxTokens,
      system: built.system,
      messages: [{ role: "user", content: built.user }],
    });
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    await logCall({
      schoolId,
      userId,
      feature: args.feature,
      promptName: args.prompt.name,
      promptVersion: args.prompt.version,
      model: built.model,
      inputHash,
      inputTokens: null,
      outputTokens: null,
      latencyMs,
      status: "error",
      errorMessage: truncate(message, ERROR_MESSAGE_LIMIT),
    });
    throw err;
  }

  const latencyMs = Date.now() - startedAt;
  await logCall({
    schoolId,
    userId,
    feature: args.feature,
    promptName: args.prompt.name,
    promptVersion: args.prompt.version,
    model: built.model,
    inputHash,
    inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null,
    latencyMs,
    status: "ok",
    errorMessage: null,
  });

  return response;
}
