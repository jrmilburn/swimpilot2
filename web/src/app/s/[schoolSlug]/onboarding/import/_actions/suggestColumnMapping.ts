"use server";

import { z } from "zod";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import { hashStableInput, withAI } from "@/ai/withAI";
import { csvColumnMap } from "@/ai/prompts/onboarding/csv-column-map";
import type { ImportTargetField } from "@/domain/types";

// Wrap the `csv-column-map` prompt for the importer's AI suggestions panel.
//
// The action layer has three jobs that the prompt module deliberately
// doesn't:
//   1. Catch every failure mode of `withAI` and turn it into a typed,
//      non-throwing result. The form must keep working when AI is down,
//      so this is the seam that makes "AI is unavailable" a regular
//      branch rather than an exception.
//   2. Validate the model's response against a zod schema. Anything the
//      model returns that isn't structurally valid, or that maps a
//      column to a target outside the allowed set, becomes
//      `invalid_response` — we do NOT try to coerce.
//   3. Decide whether the suggestion is worth showing. If every column
//      came back at `low` confidence, return `low_confidence` so the
//      panel renders the unavailable state instead of a misleading
//      "Apply suggestions" button.
//
// `ai_calls` rows are written by `withAI` itself — once on success, once
// on the SDK error path. We never write the row from here.

const TARGET_FIELDS: ImportTargetField[] = [
  "family.primary_contact_name",
  "family.primary_contact_email",
  "family.primary_contact_phone",
  "student.first_name",
  "student.last_name",
  "student.date_of_birth",
  "enrolment.level_name",
  "enrolment.day",
  "enrolment.time",
  "enrolment.frequency",
];
const ALLOWED_TARGETS = new Set<string>(TARGET_FIELDS);

const Input = z.object({
  headers: z.array(z.string()).min(1, "Need at least one header"),
  sampleRows: z.array(z.array(z.string())),
});

const ConfidenceSchema = z.enum(["high", "medium", "low"]);
const ResponseSchema = z.object({
  mapping: z.record(z.string(), z.union([z.string(), z.null()])),
  confidence: z.record(z.string(), ConfidenceSchema),
});

export type SuggestionMapping = Record<string, ImportTargetField | null>;
export type SuggestionConfidence = Record<string, "high" | "medium" | "low">;

export type SuggestColumnMappingResult =
  | { ok: true; mapping: SuggestionMapping; confidence: SuggestionConfidence }
  | {
      ok: false;
      reason: "low_confidence" | "ai_unavailable" | "invalid_response";
    };

// Chunk 2 substitutes `1970-01-01` for missing DOBs at insert time. That
// sentinel is implementation detail and could mislead the model into
// mapping an arbitrary date column wrongly. Scrub it to a literal
// placeholder before sending sample rows to the model. Decision flagged
// in the chunk-3 handoff.
const DOB_SENTINEL = "1970-01-01";
const DOB_PLACEHOLDER = "<dob-missing>";
function scrubDobSentinels(rows: string[][]): string[][] {
  return rows.map((row) =>
    row.map((cell) => (cell === DOB_SENTINEL ? DOB_PLACEHOLDER : cell)),
  );
}

const SAMPLE_ROW_LIMIT = 5;

export const suggestColumnMapping = tenantAction(
  async (
    _ctx,
    input: unknown,
  ): Promise<SuggestColumnMappingResult> => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? "Invalid input",
      );
    }

    const sampleRows = scrubDobSentinels(
      parsed.data.sampleRows.slice(0, SAMPLE_ROW_LIMIT),
    );

    let response;
    try {
      response = await withAI({
        feature: "onboarding-csv-map",
        prompt: csvColumnMap,
        input: {
          incomingColumns: parsed.data.headers,
          sampleRows,
          targetFields: TARGET_FIELDS,
        },
        hashInput: hashStableInput,
      });
    } catch (err) {
      // Any SDK failure (network, timeout, 5xx, malformed envelope) means
      // we degrade to hand-mapping. `withAI` has already written an
      // error row to `ai_calls` for us.
      console.warn("suggestColumnMapping: withAI failed", err);
      return { ok: false, reason: "ai_unavailable" };
    }

    const text = extractText(response);
    if (!text) return { ok: false, reason: "invalid_response" };

    let json: unknown;
    try {
      json = JSON.parse(stripCodeFence(text));
    } catch {
      return { ok: false, reason: "invalid_response" };
    }

    const validated = ResponseSchema.safeParse(json);
    if (!validated.success) return { ok: false, reason: "invalid_response" };

    const mapping: SuggestionMapping = {};
    for (const header of parsed.data.headers) {
      const raw = validated.data.mapping[header];
      if (raw == null) {
        mapping[header] = null;
        continue;
      }
      if (!ALLOWED_TARGETS.has(raw)) {
        return { ok: false, reason: "invalid_response" };
      }
      mapping[header] = raw as ImportTargetField;
    }

    const confidence: SuggestionConfidence = {};
    for (const header of parsed.data.headers) {
      confidence[header] = validated.data.confidence[header] ?? "low";
    }

    // If every column came back as low confidence, the suggestion isn't
    // worth showing. The operator's hand-mapping path is at least as good.
    const allLow = parsed.data.headers.every((h) => confidence[h] === "low");
    if (allLow) return { ok: false, reason: "low_confidence" };

    return { ok: true, mapping, confidence };
  },
);

function extractText(response: { content: Array<{ type: string }> }): string | null {
  for (const block of response.content) {
    if (block.type === "text") {
      const text = (block as { type: "text"; text: string }).text;
      if (typeof text === "string" && text.length > 0) return text;
    }
  }
  return null;
}

// Belt and braces: the prompt forbids code fences, but if the model adds
// them anyway we trim them rather than fail validation.
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const withoutOpen = trimmed.replace(/^```(?:json)?\s*/i, "");
  return withoutOpen.replace(/\s*```\s*$/i, "");
}
