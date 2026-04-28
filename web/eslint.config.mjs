import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const prismaImportRule = [
  "error",
  {
    patterns: [
      {
        group: ["@prisma/client", "@prisma/client/*"],
        message:
          "Prisma may only be imported from src/lib/db/** or src/repositories/**. Use a repository instead.",
      },
      {
        group: [
          "**/app/generated/prisma",
          "**/app/generated/prisma/*",
          "**/app/generated/prisma/**",
        ],
        message:
          "Prisma may only be imported from src/lib/db/** or src/repositories/**. Use a repository instead.",
      },
      {
        group: [
          "**/lib/db/client",
          "@/src/lib/db/client",
          "@/lib/db/client",
        ],
        message:
          "The Prisma client may only be imported from src/lib/db/** or src/repositories/**. Use a repository instead.",
      },
    ],
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Default ignores of eslint-config-next:
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated Prisma client — its own internals import from @prisma/client.
    "app/generated/**",
  ]),
  {
    rules: {
      "no-restricted-imports": prismaImportRule,
    },
  },
  {
    files: ["src/lib/db/**", "src/repositories/**", "tests/**"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
]);

export default eslintConfig;
