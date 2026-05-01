import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const restrictedImportsRule = [
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
          "**/generated/prisma",
          "**/generated/prisma/*",
          "**/generated/prisma/**",
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
      {
        group: ["@anthropic-ai/sdk", "@anthropic-ai/sdk/*"],
        message:
          "The Anthropic SDK may only be imported from src/ai/**. Call AI features via withAI() from src/ai/withAI instead.",
      },
      {
        group: ["@supabase/supabase-js", "@supabase/supabase-js/*"],
        message:
          "Supabase Storage is service-role only and may only be imported from src/lib/storage/**. Call assetRepository (src/repositories/assetRepository.ts) from feature code.",
      },
      {
        group: [
          "**/lib/storage/client",
          "@/src/lib/storage/client",
          "@/lib/storage/client",
        ],
        message:
          "The Supabase Storage client may only be imported from src/lib/storage/** or src/repositories/**. Use assetRepository from feature code.",
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
    "src/generated/**",
  ]),
  {
    rules: {
      "no-restricted-imports": restrictedImportsRule,
    },
  },
  // Repositories and lib/db are allowed to import Prisma. The AI scaffold
  // is allowed to import @anthropic-ai/sdk. The storage seam under
  // lib/storage and the assetRepository (under src/repositories) are the
  // only places that may construct or consume the service-role Supabase
  // client. Tests can do all of the above.
  {
    files: [
      "src/lib/db/**",
      "src/lib/storage/**",
      "src/repositories/**",
      "src/ai/**",
      "tests/**",
      "prisma/**",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
]);

export default eslintConfig;
