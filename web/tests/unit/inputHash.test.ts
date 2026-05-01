import { describe, expect, test } from "vitest";

import { hashInput } from "../../src/ai/withAI";

describe("hashInput", () => {
  test("is deterministic across runs for the same input", () => {
    const input = { foo: "bar", count: 3, items: ["a", "b"] };
    expect(hashInput(input)).toBe(hashInput(input));
  });

  test("differs for different inputs", () => {
    expect(hashInput({ a: 1 })).not.toBe(hashInput({ a: 2 }));
    expect(hashInput({ a: 1 })).not.toBe(hashInput({ a: "1" }));
    expect(hashInput([1, 2, 3])).not.toBe(hashInput([3, 2, 1]));
  });

  test("returns a 64-char hex digest", () => {
    expect(hashInput({})).toMatch(/^[0-9a-f]{64}$/);
  });

  // Documented limitation: the current implementation uses naïve
  // JSON.stringify, which preserves insertion order. Two equivalent objects
  // built with different key orderings hash differently. Sprint 5 (CSV
  // inputs) is the likely point at which we'll switch to a stable-key
  // stringifier; this test is the marker for that future flip.
  test("LIMITATION: key ordering changes the hash (naïve JSON.stringify)", () => {
    const a = { x: 1, y: 2 };
    const b: Record<string, number> = {};
    b.y = 2;
    b.x = 1;
    expect(hashInput(a)).not.toBe(hashInput(b));
  });
});
