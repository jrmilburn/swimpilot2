import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { MappingPanelProps } from "../../src/app/s/[schoolSlug]/onboarding/import/_components/MappingPanel";

// MappingPanel must be externally controllable. Sprint 5 / Chunk 2 leaves
// a hook for Chunk 3's AI-suggestions panel: it sits next to the manual
// mapping pane and proposes a different mapping. The interaction is
// "preview, then apply" — and "apply" means setting the same `value`
// the manual pane reads. If MappingPanel quietly held its own internal
// state, the AI panel could not push a new mapping in.
//
// Two checks:
//   (a) The compile-time prop contract requires `value` and `onChange`
//       — this file fails to compile if either disappears.
//   (b) The component source does NOT call `useState`/`useReducer`
//       internally for the mapping itself — a bright-line guard against
//       a future refactor accidentally re-internalising the state.

describe("MappingPanel external-control contract", () => {
  test("prop type requires value + onChange (compile-time check)", () => {
    const _required: MappingPanelProps = {
      headers: ["a"],
      value: { a: "ignore" },
      onChange: () => {},
    };
    expect(_required.headers).toEqual(["a"]);
  });

  test("source does not own internal state for the mapping", () => {
    const src = readFileSync(
      path.resolve(
        __dirname,
        "../../src/app/s/[schoolSlug]/onboarding/import/_components/MappingPanel.tsx",
      ),
      "utf8",
    );
    // The page lifts state for the mapping; the panel only relays
    // through `onChange`. Reject any local state hook in this file.
    expect(src).not.toMatch(/\buseState\b/);
    expect(src).not.toMatch(/\buseReducer\b/);
  });
});
