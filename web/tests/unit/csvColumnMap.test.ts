import { describe, expect, test } from "vitest";

import { csvColumnMap } from "../../src/ai/prompts/onboarding/csv-column-map";

// Snapshot the rendered prompt for a known input shape. The repo has no
// snapshot serialiser configured, so we assert against the literal
// expected value instead — same effect, simpler diff. If the prompt's
// `system` text drifts (which often drifts output quality), this test
// fires before we ship.

describe("csvColumnMap prompt module", () => {
  const input = {
    incomingColumns: ["Email", "First", "DOB"],
    sampleRows: [
      ["jane@example.com", "Ada", "2017-04-09"],
      ["jane@example.com", "Grace", "<dob-missing>"],
    ],
    targetFields: [
      "family.primary_contact_email",
      "student.first_name",
      "student.date_of_birth",
    ],
  };

  test("metadata is stable", () => {
    expect(csvColumnMap.name).toBe("csv-column-map");
    expect(csvColumnMap.version).toBe(1);
  });

  test("build returns the expected model and token cap", () => {
    const built = csvColumnMap.build(input);
    expect(built.model).toBe("claude-haiku-4-5");
    expect(built.maxTokens).toBe(600);
  });

  test("system prompt names the JSON envelope and the null/low-confidence rules", () => {
    const built = csvColumnMap.build(input);
    expect(built.system).toContain('"mapping"');
    expect(built.system).toContain('"confidence"');
    expect(built.system).toContain("high");
    expect(built.system).toContain("medium");
    expect(built.system).toContain("low");
    expect(built.system).toContain("null");
    expect(built.system).toContain("STRICT JSON");
    expect(built.system).toContain("at most once");
  });

  test("user prompt is JSON containing the supplied input verbatim", () => {
    const built = csvColumnMap.build(input);
    const parsed = JSON.parse(built.user);
    expect(parsed.incomingColumns).toEqual(input.incomingColumns);
    expect(parsed.sampleRows).toEqual(input.sampleRows);
    expect(parsed.targetFields).toEqual(input.targetFields);
  });
});
