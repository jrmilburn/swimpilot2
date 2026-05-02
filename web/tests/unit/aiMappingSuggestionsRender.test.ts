import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { AiMappingSuggestionsProps } from "../../src/app/s/[schoolSlug]/onboarding/import/_components/AiMappingSuggestions";

// Behavioural smoke tests for `AiMappingSuggestions` would normally render
// the component in jsdom and click through the apply flow, but this repo
// runs vitest in a node environment without `@testing-library/react`.
// Adding the dep would touch other tests' setup, which is out of scope
// for this chunk. Instead we follow the same pattern as
// `mappingPanelContract.test.ts`:
//   (a) compile-time prop contract check (a behavioural change to the
//       prop shape would fail to typecheck this file)
//   (b) source-text guards that pin the wiring against accidental drift
//       — the component must call `suggestColumnMapping`, must call
//       `onApply`, and must own its own UI state (the prop list does
//       not include any state the page should be lifting).
// The full action-layer behaviour is exercised by
// `tests/integration/suggestColumnMapping.test.ts`.

const PANEL_PATH = path.resolve(
  __dirname,
  "../../src/app/s/[schoolSlug]/onboarding/import/_components/AiMappingSuggestions.tsx",
);

describe("AiMappingSuggestions contract", () => {
  test("prop type is { headers, sampleRows, onApply }", () => {
    const _required: AiMappingSuggestionsProps = {
      headers: ["a"],
      sampleRows: [["x"]],
      onApply: () => {},
    };
    expect(_required.headers).toEqual(["a"]);
  });

  test("source imports the action and calls onApply on apply", () => {
    const src = readFileSync(PANEL_PATH, "utf8");
    expect(src).toMatch(/from "..\/_actions\/suggestColumnMapping"/);
    expect(src).toMatch(/suggestColumnMapping\(/);
    expect(src).toMatch(/onApply\(next\)/);
  });

  test("source fires the action from a useEffect on headers", () => {
    const src = readFileSync(PANEL_PATH, "utf8");
    expect(src).toMatch(/useEffect/);
    // The fetch must be gated by headers presence so a re-render with
    // null headers doesn't trigger a stray AI call.
    expect(src).toMatch(/!headers/);
  });

  test("source surfaces the unavailable state distinctly from the ready state", () => {
    const src = readFileSync(PANEL_PATH, "utf8");
    expect(src).toMatch(/AI mapping unavailable/);
    expect(src).toMatch(/Apply suggestions/);
  });
});
