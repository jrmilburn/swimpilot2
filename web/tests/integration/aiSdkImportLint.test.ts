import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ESLint } from "eslint";
import path from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

// This test confirms the ESLint rule extension banning @anthropic-ai/sdk
// imports outside src/ai/** is wired up. The pattern mirrors the existing
// repository-import lint rule: it writes a temporary file outside the
// allowed directories with a deliberate import, asks ESLint to lint it,
// and asserts a no-restricted-imports violation came back. Inversely,
// the same import inside src/ai/** must NOT trip the rule.

const ROOT = path.resolve(__dirname, "..", "..");
const TMP_DIR = path.resolve(ROOT, "tests", "_tmp");

beforeAll(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("ESLint: @anthropic-ai/sdk import boundary", () => {
  test("a file outside src/ai/** importing the SDK fails the rule", async () => {
    const offending = path.join(ROOT, "src", "lib", "_lint_test_sdk.ts");
    writeFileSync(
      offending,
      `import Anthropic from "@anthropic-ai/sdk";\nexport default Anthropic;\n`,
    );

    try {
      const eslint = new ESLint({ cwd: ROOT });
      const results = await eslint.lintFiles([offending]);
      const messages = results.flatMap((r) => r.messages);
      const restricted = messages.filter(
        (m) => m.ruleId === "no-restricted-imports",
      );
      expect(restricted.length).toBeGreaterThan(0);
    } finally {
      rmSync(offending, { force: true });
    }
  });

  test("a file inside src/ai/** importing the SDK is allowed", async () => {
    const allowed = path.join(ROOT, "src", "ai", "_lint_test_allowed.ts");
    writeFileSync(
      allowed,
      `import Anthropic from "@anthropic-ai/sdk";\nexport default Anthropic;\n`,
    );

    try {
      const eslint = new ESLint({ cwd: ROOT });
      const results = await eslint.lintFiles([allowed]);
      const messages = results.flatMap((r) => r.messages);
      const restricted = messages.filter(
        (m) => m.ruleId === "no-restricted-imports",
      );
      expect(restricted.length).toBe(0);
    } finally {
      rmSync(allowed, { force: true });
    }
  });
});
