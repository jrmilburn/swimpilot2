import { describe, expect, test } from "vitest";

import { hashStableInput } from "../../src/ai/withAI";

describe("hashStableInput", () => {
  test("is deterministic across runs for the same input", () => {
    const input = { foo: "bar", count: 3, items: ["a", "b"] };
    expect(hashStableInput(input)).toBe(hashStableInput(input));
  });

  test("collides on key-order permutations at the top level", () => {
    const a = { x: 1, y: 2 };
    const b: Record<string, number> = {};
    b.y = 2;
    b.x = 1;
    expect(hashStableInput(a)).toBe(hashStableInput(b));
  });

  test("collides on key-order permutations nested deep inside", () => {
    const a = { wrap: { x: 1, y: 2, z: { p: 3, q: 4 } } };
    const b = { wrap: { z: { q: 4, p: 3 }, y: 2, x: 1 } };
    expect(hashStableInput(a)).toBe(hashStableInput(b));
  });

  test("differs for different inputs", () => {
    expect(hashStableInput({ a: 1 })).not.toBe(hashStableInput({ a: 2 }));
    expect(hashStableInput({ a: 1 })).not.toBe(hashStableInput({ a: "1" }));
    expect(hashStableInput({ a: 1 })).not.toBe(hashStableInput({ b: 1 }));
  });

  test("preserves array order — arrays are ordered, only object keys are sorted", () => {
    expect(hashStableInput([1, 2, 3])).not.toBe(hashStableInput([3, 2, 1]));
    expect(hashStableInput({ xs: ["a", "b"] })).not.toBe(
      hashStableInput({ xs: ["b", "a"] }),
    );
  });

  test("returns a 64-char hex digest", () => {
    expect(hashStableInput({})).toMatch(/^[0-9a-f]{64}$/);
  });
});
