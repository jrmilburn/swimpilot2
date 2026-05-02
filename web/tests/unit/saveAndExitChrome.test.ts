import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Sprint 5 / Chunk 3 — save-and-exit affordance.
//
// Decision: a single `<Link>` in the wizard chrome (the onboarding
// layout) covers every step, instead of a per-step intent. The chunk-3
// brief says "Pick whichever shape composes best with what Chunks 1 and 2
// already did" — Chunks 1 and 2 didn't add per-step intents, the chrome
// link they inherited from Sprint 4 was sufficient. A per-step intent
// would have been duplicate plumbing.
//
// The contract: every onboarding step renders inside the layout, and
// the layout renders a `<Link href="/s/<schoolSlug>">Save and exit</Link>`.
// Whatever a step's form holds in flight (e.g. a half-typed class name)
// is lost on click — pre-chunk gate decision #3, confirmed by the
// operator. Same shape as every other "back to dashboard" path in the
// app. No confirmation dialog.

const LAYOUT_PATH = path.resolve(
  __dirname,
  "../../src/app/s/[schoolSlug]/onboarding/layout.tsx",
);

describe("save-and-exit chrome contract", () => {
  test("layout renders a Save and exit Link to /s/<schoolSlug>", () => {
    const src = readFileSync(LAYOUT_PATH, "utf8");
    expect(src).toMatch(/Save and exit/);
    // The link must point at the school dashboard, not at a per-step
    // route. Using a string template means the test can't pin the
    // exact rendered URL — but it can pin the source-level shape.
    expect(src).toMatch(/href={`\/s\/\$\{schoolSlug\}`}/);
    expect(src).toMatch(/<Link\b/);
  });

  test("every wizard step renders under the onboarding layout", () => {
    // Co-locating the page files under `onboarding/<step>/page.tsx` is
    // what gives them the layout. If a step ever moves out, the chrome
    // link no longer covers it and this test fires.
    const stepRoot = path.resolve(
      __dirname,
      "../../src/app/s/[schoolSlug]/onboarding",
    );
    const steps = [
      "profile",
      "locations",
      "levels",
      "skills",
      "classes",
      "teachers",
      "import",
    ];
    for (const step of steps) {
      const pagePath = path.join(stepRoot, step, "page.tsx");
      // readFileSync throws if the file is missing — that's the test.
      readFileSync(pagePath, "utf8");
      expect(pagePath).toMatch(new RegExp(`${step}/page\\.tsx$`));
    }
  });
});
