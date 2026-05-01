import type { PromptModule } from "../../types";

// The canonical example prompt. Tiny, intentionally low-stakes — the smoke
// endpoint exercises the full pathway through this module without doing
// anything useful in production. Sprint 5 (`prompts/onboarding/...`) and
// Sprint 10 (`prompts/inbox/...`) replicate this shape.
//
// Default-model guidance lives in /docs/architecture.md → "AI scaffold".
// Family summarisation is short, structured, and judgement-light, so Haiku.

export interface FamilySummaryInput {
  primaryContactName: string;
  studentCount: number;
  studentFirstNames: string[];
}

export const familySummary: PromptModule<FamilySummaryInput> = {
  name: "family-summary",
  version: 1,
  build: (input) => ({
    system:
      "You are a concise assistant. Reply in one sentence, no more than 20 words.",
    user: `Summarise this family: ${input.primaryContactName} with ${input.studentCount} student(s) named ${input.studentFirstNames.join(", ")}.`,
    model: "claude-haiku-4-5",
    maxTokens: 100,
  }),
};
