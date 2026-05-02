"use server";

import { parse } from "csv-parse/sync";
import { z } from "zod";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";

// Caps. Decision-flagged: the importer is for onboarding's "first roster",
// not for arbitrary bulk loads. Larger CSVs should be split or routed to
// the (post-Sprint-6) admin importer.
const MAX_CSV_BYTES = 1_000_000; // 1 MB
const MAX_CSV_ROWS = 1_000;

const Input = z.object({
  csvText: z.string().min(1, "CSV is empty"),
});

export type ParseCsvResult = {
  headers: string[];
  rows: string[][];
};

// UTF-8 BOM is invisible but breaks header equality checks. Strip it
// once at the boundary instead of teaching every comparator about it.
// Decision #5 in the handoff.
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export const parseCsvAction = tenantAction(
  async (_ctx, input: unknown): Promise<ParseCsvResult> => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? "Invalid input",
      );
    }
    const text = stripBom(parsed.data.csvText);

    // Byte cap. Use Buffer.byteLength for the actual UTF-8 size — string
    // length counts code units, not bytes, so a CSV full of multi-byte
    // chars could slip past a length check.
    if (Buffer.byteLength(text, "utf8") > MAX_CSV_BYTES) {
      throw new ValidationError(
        `CSV is larger than ${MAX_CSV_BYTES / 1000} KB. Split it into smaller files.`,
      );
    }

    let records: string[][];
    try {
      records = parse(text, {
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        bom: true,
      }) as string[][];
    } catch (err) {
      throw new ValidationError(
        `Could not parse CSV: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }

    if (records.length === 0) {
      throw new ValidationError("CSV had no rows.");
    }
    const headers = (records[0] ?? []).map((h) => h.trim());
    const dataRows = records.slice(1);

    if (dataRows.length > MAX_CSV_ROWS) {
      throw new ValidationError(
        `CSV has ${dataRows.length} rows; the importer accepts up to ${MAX_CSV_ROWS}.`,
      );
    }

    return { headers, rows: dataRows };
  },
);
