# Sprint 3 / Chunk 6 — handoff

## What landed

- `@anthropic-ai/sdk` pinned to `~0.92.0` in `package.json`. Tilde
  range — patch updates only. Bumping the minor is a deliberate
  decision, not an `npm install` accident.
- `ai_calls` table (migration `20260501120000_add_ai_calls`) — one
  row per SDK call, FORCE ROW LEVEL SECURITY scoped on
  `current_setting('app.school_id')` with a `tenant_isolation` policy
  in the same shape as every other tenant table. Columns: `school_id`
  (FK), `user_id` (nullable, intentionally *not* a FK so a deleted
  user doesn't cascade-delete history), `feature`, `prompt_name`,
  `prompt_version`, `model`, `input_hash`, `input_tokens`,
  `output_tokens`, `latency_ms`, `status` (`ok` / `error`),
  `error_message`, plus the standard audit columns. CHECK constraints
  on non-negative latency and tokens. Four indexes — school + created
  desc, school + feature + created desc, partial on `status='error'`,
  and school + user.
- `AiCall` Prisma model + `AiCallStatus` enum, with `aiCalls
  AiCall[]` relation on `School`. `AiCall` added to the
  `DOMAIN_MODELS` set in `src/lib/db/extensions.ts` so `created_by` /
  `updated_by` are stamped automatically by the audit extension.
- `src/ai/client.ts` — single source of truth for the SDK client.
  Lazy singleton via a `Proxy` so module load doesn't construct the
  client (see "Decisions" below). Throws if
  `ANTHROPIC_API_KEY` is missing in production; logs a warning and
  uses a placeholder in dev/test. Exports `anthropic` (the proxied
  singleton) and `getAnthropic()` (escape hatch).
- `src/ai/types.ts` — `PromptModule<TInput>` interface (name,
  numeric version, `build(input) → { model, system?, messages,
  maxTokens, temperature? }`), `PromptResult`, and `AICallContext`.
- `src/ai/withAI.ts` — the wrapper. Reads tenant context from
  `AsyncLocalStorage` via `getActorId()` / `getSchoolId()`. Throws
  `MissingTenantContextError` if `school_id` isn't in scope.
  `user_id` is `null` when the actor is the system user. Hashes
  inputs (SHA-256 of `JSON.stringify(input)`) — does *not* store the
  raw input. Times the SDK call. On success writes a `status='ok'`
  row with token usage; on error writes a `status='error'` row with
  the error message truncated to 1000 chars and re-throws the
  original. Logging is best-effort — failures are caught and
  `console.error`'d but never block the caller. The log write happens
  in its own short transaction so a slow Claude call doesn't hold
  locks the upstream caller may have taken.
- `src/ai/prompts/system/family-summary.ts` — example
  `PromptModule<FamilySummaryInput>`. Model `claude-haiku-4-5`,
  `max_tokens: 100`. Used by the smoke route below; demonstrates the
  shape Sprint 5 / Sprint 10 prompts will follow.
- `src/app/api/ai/smoke/route.ts` — `POST` returns 404 when
  `NODE_ENV=production`. Otherwise resolves session → opens
  `withTenant` → calls `withAI({ feature: 'system.family_summary',
  prompt: familySummary, input })` → returns `{ id, model, text,
  usage }`.
- `eslint.config.mjs` — added a `no-restricted-imports` pattern for
  `@anthropic-ai/sdk` and `@anthropic-ai/sdk/*`. Allowlist files
  (`src/ai/**`, alongside the existing `src/lib/db/**` /
  `src/repositories/**` / `tests/**`) override the rule. Prevents
  routes / pages / repositories from reaching for the SDK directly
  and bypassing the wrapper.
- `.env.example` — new file. Documents `DATABASE_URL`,
  `ADMIN_DATABASE_URL`, the Clerk keys, and `ANTHROPIC_API_KEY`.
  Copies the "required in production" rule for the AI key.
- 7 integration test files plus 1 unit test:
  - `tests/unit/inputHash.test.ts` — deterministic, differs across
    inputs, 64-char hex digest, and an explicit LIMITATION test that
    documents the naïve `JSON.stringify` key-order weakness.
  - `tests/integration/withAI.test.ts` — happy path. Mocks the
    client, asserts the row written has the correct school, user,
    feature, prompt name + version, model, hash shape, token counts,
    `status='ok'`, and audit fields.
  - `tests/integration/withAIOutsideTenant.test.ts` — confirms
    `MissingTenantContextError` is thrown and no SDK call /
    `ai_calls` row results.
  - `tests/integration/withAIError.test.ts` — re-throws the SDK
    error with the original message, writes `status='error'`,
    truncates the error message to exactly 1000 chars.
  - `tests/integration/withAILoggingFailure.test.ts` — when the log
    write itself fails the SDK response is still returned and
    `console.error` is called.
  - `tests/integration/crossTenantAICalls.test.ts` — RLS isolation:
    two tenants each write a row; admin sees both, each tenant sees
    only their own.
  - `tests/integration/aiSdkImportLint.test.ts` — runs ESLint
    against a temp file outside `src/ai/` and asserts the rule
    fires; reverse test confirms a file inside `src/ai/` does *not*
    trigger.
- `docs/architecture.md` extended with an "AI scaffold" section:
  folder layout, the `PromptModule` shape, the eight-point `withAI`
  contract, the default model split (Haiku for
  classification/extraction, Opus for generative/judgement),
  the ESLint boundary, the `ai_calls` table, the SDK pinning policy,
  and explicit "Sprint 5 plug-in" / "Sprint 10 plug-in" sections so
  the next sprint can add prompts without rediscovering the
  conventions.

## Decisions worth flagging

### Lazy singleton via Proxy

First pass had `client.ts` construct the SDK client at module load.
That broke `next build` — the production-key check threw during
Next.js's static page-data collection step, before any request had
ever touched the SDK. Switched to a `Proxy` that defers construction
until the first property access. The named export `anthropic` keeps
working (so `vi.mock` in tests still works), production still fails
loudly the moment something actually calls the SDK, and `next build`
no longer needs the key set. Documented in `architecture.md`.

### Log write in its own transaction

`withAI` does not write the `ai_calls` row inside the caller's
transaction — it opens a fresh, short transaction in `logCall`
(setting the `app.school_id` GUC inline). Reasoning: a Claude call
can take 5–30s, and we don't want the upstream caller's transaction
holding row locks for that whole window. Trade-off: if the caller's
transaction later rolls back, the `ai_calls` row stays — which is
what we want (we still spent the tokens). The audit-extension stamps
`created_by` / `updated_by` correctly because `getActorId()` reads
from `AsyncLocalStorage`, which propagates through the nested
transaction. Sprint 5 / Sprint 10 should not change this without
revisiting the lock-holding question.

### `user_id` is not a FK

Deliberate. Deleting a user shouldn't cascade-delete their AI call
history (compliance / audit). Indexed only. Same pattern we'll use
for any future `actor_id`-style columns where the actor lifetime is
shorter than the audit row's.

### Naïve `JSON.stringify` for input hashing

Hash is `sha256(JSON.stringify(input))`. Object key ordering matters
— `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce different hashes.
For the current use case (system-internal prompts where the caller
controls the shape) that's fine. Sprint 5's CSV column-mapping
prompt will pass user-provided objects whose key order isn't stable;
that prompt should switch to a stable-key serialiser
(`json-stable-stringify` or hand-rolled) when it lands. The unit
test `inputHash.test.ts → LIMITATION` documents this so future-me
can find it.

### Default model split (Haiku vs Opus)

Convention written into `architecture.md`:
- Haiku (`claude-haiku-4-5`) — classification, extraction,
  short-form transformation. Fast, cheap, deterministic-enough.
  Sprint 5 (CSV column-mapping) and Sprint 10 (inbox classification)
  default to Haiku.
- Opus (`claude-opus-4-7`) — generative output, free-form
  judgement, anything user-visible. Sprint 10's reply-suggestion
  prompt defaults to Opus.

The `PromptModule.build()` return value is the only place the model
is named — switching a prompt is a one-line change.

## What Sprint 5 / Sprint 10 need to wire up

- Sprint 5 — `src/ai/prompts/onboarding/csv-column-map.ts`, a
  `PromptModule<CsvColumnMapInput>` returning a JSON envelope of
  `{ column → field }`. Use Haiku. Switch the input hasher to a
  stable-key serialiser before calling `withAI`.
- Sprint 10 — `src/ai/prompts/inbox/classify.ts` (Haiku) and
  `src/ai/prompts/inbox/suggest-reply.ts` (Opus). Both will call
  `withAI` directly; the wrapper already covers tenant scoping,
  logging, and the audit trail.
- Output validation, retry, streaming, caching, and an eval harness
  are deliberately *not* in this chunk. When any of those is needed,
  it goes inside `withAI` (or a `runStreaming` sibling), not at the
  call site.
- `ANTHROPIC_API_KEY` is *not* set in Vercel — secret was not
  pushed in this session. Set in dev (`.env`) and prod (`vercel env
  add`) before either Sprint 5 or Sprint 10 ships a real call.

## Verification

- `npx prisma generate` succeeded after the schema changes; the
  migration was applied to the test database via `npm run
  test:db:migrate`.
- `npx tsc --noEmit` is clean.
- All 12 chunk-6 tests pass against a real Postgres (Docker compose
  test stack). The full suite at the time of writing was 47 of 48
  test files passing — the one failure was
  `tests/integration/tenantRouting.test.ts` with `Error: 'cookies'
  was called outside a request scope` from the Next.js landing
  page, pre-existing and unrelated to this chunk (verified by
  stashing chunk-6 changes and re-running — failure persisted).
- The smoke route compiles and routes correctly. Not exercised
  against the real SDK in this session because no API key was set
  locally; the wrapper itself is exercised by the integration tests
  via a mocked client.
