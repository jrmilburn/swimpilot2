import type { PromptModule } from "../../types";

// CSV column-mapping classifier. Operator pastes a CSV with arbitrary
// header names; we ask the model to map each header to one of SwimPilot's
// known target fields (or `null` if it can't tell). Haiku is the right
// choice — short structured-output classification, low stakes, fast.
//
// The prompt's contract: model returns a JSON object with `mapping` and
// `confidence` keyed by *incoming column name*. Validation lives in the
// action wrapper; this module only builds the call.
//
// Sample-row handling: Chunk 2 substitutes the sentinel date `1970-01-01`
// when DOB is missing, since `students.date_of_birth` is NOT NULL. The
// sentinel is implementation detail and could mislead the model into
// mis-mapping a date column. The action layer scrubs it to a literal
// "<dob-missing>" placeholder before calling `build`. Documented in the
// chunk-3 handoff.
//
// Default-model guidance lives in /docs/architecture.md → "AI scaffold".

export interface CsvColumnMapInput {
  incomingColumns: string[];
  sampleRows: string[][];
  targetFields: string[];
}

export const csvColumnMap: PromptModule<CsvColumnMapInput> = {
  name: "csv-column-map",
  version: 1,
  build: (input) => ({
    model: "claude-haiku-4-5",
    maxTokens: 600,
    system: [
      "You map columns from a school's CSV roster to SwimPilot's known target fields.",
      "",
      'Output STRICT JSON matching this shape, with no commentary, no code fences, and no extra keys:',
      '{ "mapping": { "<incomingColumn>": "<targetField>" | null, ... },',
      '  "confidence": { "<incomingColumn>": "high" | "medium" | "low", ... } }',
      "",
      "Rules:",
      "- Every key in `mapping` and `confidence` MUST be one of the incoming column names exactly as supplied.",
      "- Values in `mapping` MUST be either one of the supplied target fields exactly, or null.",
      "- Use null when you cannot confidently identify the column. Do not guess.",
      "- Use `low` confidence when you have a guess but you are not sure; pair `low` with null if the guess is too weak to use.",
      "- Each target field may be used at most once across the mapping. If two columns plausibly map to the same field, pick the better one and null the other.",
      "- Sample rows are illustrative; do not infer schema from a single noisy value.",
    ].join("\n"),
    user: JSON.stringify(
      {
        incomingColumns: input.incomingColumns,
        targetFields: input.targetFields,
        sampleRows: input.sampleRows,
      },
      null,
      2,
    ),
  }),
};
