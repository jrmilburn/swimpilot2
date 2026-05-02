# Sprint 5 / Chunk 3 — handoff (and Sprint 5 closeout)

The closer for Sprint 5. Three groups:

- **Group A — AI column-mapping suggestions.** A Haiku-backed panel
  sits beside the manual `MappingPanel` in the importer; on parse,
  it fires a stable-keyed `withAI` call and renders one of three
  states (pending / ready / unavailable). Apply translates the
  draft into the page's mapping shape and lets the existing
  externally-controllable `MappingPanel` reflect the change.
  Confidence indicators live on the AI panel only — the
  `mappingPanelContract` test from Chunk 2 still rejects any
  attempt to push them into `MappingPanel`.
- **Group B — Journey-test redirect assertions.** Both the happy and
  skip walks in `onboardingJourney.test.ts` now assert that the
  final `saveImportForm` call throws a `NEXT_REDIRECT` digest
  pointing at `/s/<slug>`, plus a final sweep on the skip path
  asserting all six skip-able step statuses are `Skipped`.
- **Group C — Closeout polish.** A single `<Link>` save-and-exit in
  the wizard chrome covers every step (decision flagged below).
  `HELP_URL`'s carry-forward TODO now points at Sprint 6.
  `docs/architecture.md`'s Onboarding section gets three new
  sub-sections covering Classes, Teachers, and Import. Empty-state
  intros on Classes / Import gain the same "you can come back
  later" reassurance the earlier steps already had.

This chunk introduces one new piece of architecture: a stable-key
hasher (`hashStableInput`) on the AI seam. Sprint 3 / Chunk 6 left
a note that Sprint 5's CSV inputs would want a deterministic
serialiser — JSON.stringify's key order is insertion-order, which
isn't a stable cache key for objects assembled across rerenders.
The flip is small: a sorted-key recursive serialiser, sha256'd,
opt-in via a new `hashInput` field on `WithAIArgs`. Existing
callers keep the default hasher.

## What landed

### Group A — AI column mapping

- **`src/ai/withAI.ts` (modified).** New `hashStableInput(input)`
  helper plus its `stableStringify(value)` recursive driver
  (sorts object keys, preserves array order). Optional `hashInput`
  field on `WithAIArgs<TInput>` defaults to the existing hasher
  when unset, so only the CSV path opts in. Public surface:
  `hashStableInput` is exported for tests.

- **`src/ai/prompts/onboarding/csv-column-map.ts` (created).**
  `PromptModule<{ headers: string[]; sampleRows: string[][]; allowedTargets: ImportTargetField[] }>`.
  Haiku model (`claude-haiku-4-5`), `maxTokens: 600`, JSON envelope
  with `mapping` and `confidence` keys. System prompt enforces:
  `null` for unsure, each target used at most once, `<dob-missing>`
  sentinel for empty / placeholder DOBs (the importer substitutes
  `1970-01-01` server-side; the prompt sees the placeholder, not
  the sentinel).

- **`src/app/s/[schoolSlug]/onboarding/import/_actions/suggestColumnMapping.ts` (created).**
  `tenantAction`-wrapped. Returns the discriminated union
  `SuggestColumnMappingResult = { ok: true, mapping, confidence }
  | { ok: false, reason: "low_confidence" | "ai_unavailable" | "invalid_response" }`.
  Three failure paths fold into the same `{ ok: false, reason }`
  shape so the panel's render stays a three-way switch. Catches
  every `withAI` throw → `ai_unavailable` (the corresponding
  `ai_calls` row is already written by `withAI`'s outer try/catch).
  Validates response against zod (`mapping` keyed by header,
  values either `null` or an `ImportTargetField`; `confidence`
  keyed by header, values `"high" | "medium" | "low"`). Strips
  ```json``` code fences belt-and-braces. All-low confidence →
  `low_confidence`. Targets outside the allowed set →
  `invalid_response`. DOB sentinel `1970-01-01` is rewritten to
  `<dob-missing>` before the model sees the sample rows.

- **`src/app/s/[schoolSlug]/onboarding/import/_components/AiMappingSuggestions.tsx` (created).**
  Three states: `pending` (placeholder text, `aria-live="polite"`),
  `ready` (per-header preview + confidence badge + Apply button),
  `unavailable` (single line: "AI mapping unavailable — map
  columns manually."). Fires once per fresh parse via a
  `headers.join("\u0001")` key in a ref. All `setState` calls
  inside `startTransition` to satisfy
  `react-hooks/set-state-in-effect`. Apply translates the panel's
  draft (target | null) into the page's shape (target | "ignore")
  and calls `onApply(mapping)`; the page sets the mapping and the
  existing `MappingPanel` reflects the change because it is
  externally controllable.

- **`ImportWorkspace.tsx` (modified).** New
  `<AiMappingSuggestions headers={headers} sampleRows={previewRows} onApply={setMapping} />`
  rendered between the preview pane and the manual mapping panel.

### Group B — journey test redirect assertions

- **`tests/integration/onboardingJourney.test.ts` (modified).**
  Both the happy and skip paths now end with:
  ```ts
  await expect(saveImportForm(initialImportFormState, fd)).rejects.toMatchObject({
    digest: expect.stringMatching(/NEXT_REDIRECT.*\/s\/riverside/),
  });
  ```
  Asserts the wizard's terminal step actually redirects. The skip
  path also adds a final sweep that re-reads
  `onboarding_progress.step_statuses` and asserts every skip-able
  step (Profile / Levels / Skills / Classes / Teachers / Import) is
  `Skipped`. Locations is the only step that cannot skip, per
  Chunk 3 of Sprint 4.

### Group C — closeout polish

- **`src/app/s/[schoolSlug]/onboarding/layout.tsx` (modified).**
  The chrome `<Link href={\`/s/${schoolSlug}\`}>Save and exit</Link>`
  has been there since Sprint 4 / Chunk 1 — no per-step intent was
  needed. `HELP_URL`'s placeholder TODO is updated from
  `(post-Sprint 4)` to `(Sprint 6)` with the carry-forward note.

- **`tests/unit/saveAndExitChrome.test.ts` (created).** Two tests.
  First reads the layout source and asserts the literal `Save and
  exit` string, the `<Link>` element, and the `href={\`/s/${schoolSlug}\`}`
  shape. Second asserts every wizard step has a `page.tsx` under
  `onboarding/<step>/` so the chrome link covers all of them by
  layout inheritance — if a step ever moves out from under the
  layout, this test fires.

- **`docs/architecture.md` (modified).** The Onboarding section's
  stale "Sprint 5 stub" sub-section is gone. Three new sub-sections
  in its place: **Classes step** (per-level accordion, capacity
  invariant, location FK), **Teachers step** (XOR CHECK on
  `(teacher_id, pending_teacher_invitation_id)`, atomic swap on
  invitation acceptance), **Import step** (four validation rule
  families, SAVEPOINT-based dry-run, AI suggestions panel +
  externally-controllable manual pane).

- **Empty-state copy.** `classes/page.tsx` and `import/page.tsx`
  pick up the same "you can come back later" reassurance the
  Locations / Levels / Skills steps had since Sprint 4. Teachers's
  intro already had it from Chunk 1.

### Tests

- `tests/unit/hashStableInput.test.ts` (6 tests) — same input →
  same hash, top-level reorder, deeply nested reorder, different
  inputs, array order preserved, 64-char hex digest.
- `tests/unit/csvColumnMap.test.ts` (4 tests) — module metadata,
  model + token cap, system-prompt rules, user prompt is JSON
  containing the input verbatim.
- `tests/integration/suggestColumnMapping.test.ts` (6 tests) —
  happy path + `ai_calls` row written, code-fence stripping,
  `ai_unavailable` on SDK throw + error row, `invalid_response` on
  malformed JSON, `invalid_response` on out-of-set target,
  `low_confidence` on all-low.
- `tests/unit/aiMappingSuggestionsRender.test.ts` (4 tests) —
  contract-style: compile-time prop check + source-text guards
  (the repo doesn't have jsdom / testing-library; behavioural
  coverage lives in `suggestColumnMapping.test.ts`).
- `tests/unit/saveAndExitChrome.test.ts` (2 tests) — see above.

## Decisions worth flagging

### 1. AI panel calls the action directly, not via a bridge intent

`useActionState` is the Sprint 4 pattern for `<form action>` flows
that survive a redirect. The AI panel is not a form — it fires
once per parse, the result lives in component state until Apply,
and a redirect would lose the suggestion. `useTransition` over a
direct call to the typed action is the right shape: the parent
keeps handling higher-priority work (operator typing in the
manual mapping pane) while AI is mapping. The existing parse /
dry-run / commit / rollback intents stay on the bridge because
they share state with the workspace; AI suggestions is a
self-contained sidecar.

### 2. Confidence indicators live in `AiMappingSuggestions`, not `MappingPanel`

Chunk 2's `mappingPanelContract` test reads the source of
`MappingPanel.tsx` and rejects `useState` / `useReducer`. It also
forms an implicit contract: the panel renders the operator's
mapping verbatim, with no opinion of its own. Pushing AI
confidence into `MappingPanel` would either re-internalise state
(fail the contract test) or pollute the manual pane with
suggestion-only props the operator doesn't care about once they
hit Apply. The two panels live side by side instead, talking only
through the lifted `mapping` state.

### 3. Stable-key hash, not just JSON.stringify, for the CSV cache key

`JSON.stringify` walks insertion-order on objects. The CSV input
to `withAI` is `{ headers, sampleRows, allowedTargets }`, where
the order is fixed at the call site, so today's behaviour is
stable in practice. **But** the cache-key contract is the
guarantee, not the current call site. A future caller that
assembles input across renders, or substitutes a deeply nested
config object, would break the cache silently and pay an extra
Anthropic call per render. `hashStableInput` is one helper, opt-in
via a new optional field, exported for tests. Worth the 30 lines.

### 4. DOB sentinel scrubbed before the model sees it

The importer substitutes `1970-01-01` for missing DOBs (Sprint 5 /
Chunk 2 / decision #4 — `students.date_of_birth` is `NOT NULL` and
making it nullable was out of scope). The AI sees the placeholder
`<dob-missing>` instead. Reasoning: the model would otherwise
confidently map a "DOB" header to the column with `1970-01-01`
values and we'd over-trust its confidence on a synthetic value.
The substitution is one-way at request time; the importer's own
DOB parser handles the sentinel separately on the server.

### 5. `ai_unavailable` covers every `withAI` failure mode

`withAI` already writes `ai_calls` rows on both success and
failure (Sprint 3 / Chunk 6). The action layer doesn't need to
distinguish "API down" from "JSON parse failed" from "rate
limited" — the panel's render is identical, and the audit row is
already there. The only failure modes the panel does distinguish
are the **content-level** ones (`low_confidence`,
`invalid_response`) because they're operator-actionable signals,
not operational ones. If a future operator surface wants to
distinguish "transient" vs "permanent" failure, the audit table
already has the data.

### 6. Save-and-exit is one chrome link, not seven per-step intents

The chunk-3 brief said "Pick whichever shape composes best with
what Chunks 1 and 2 already did." Chunks 1 and 2 didn't add any
per-step intent — the chrome link inherited from Sprint 4 was
sufficient. A per-step intent in addition to the chrome link
would have been duplicate plumbing with no operator-visible
difference. The contract test reads the layout source and asserts
the link's existence + every step's `page.tsx` lives under the
layout, so future-me can't accidentally move a step out from
under the chrome.

### 7. AI panel render test is contract-style, not jsdom

The repo does not have `jsdom` or `@testing-library/react`. The
chunk-3 brief did not require adding them. `aiMappingSuggestionsRender.test.ts`
follows the pattern set by `mappingPanelContract.test.ts`:
compile-time prop-shape check + source-text guards for the three
visible states. Behavioural coverage lives in
`suggestColumnMapping.test.ts` (the action layer), which exercises
every reason path against a mocked Anthropic SDK. If a future
sprint adds jsdom for genuinely interactive UX (drag-and-drop,
async previews), the render test can be promoted then.

## Files touched

```
M  docs/architecture.md
M  src/ai/withAI.ts
M  src/app/s/[schoolSlug]/onboarding/classes/page.tsx
M  src/app/s/[schoolSlug]/onboarding/import/_components/ImportWorkspace.tsx
M  src/app/s/[schoolSlug]/onboarding/import/page.tsx
M  src/app/s/[schoolSlug]/onboarding/layout.tsx
M  tests/integration/onboardingJourney.test.ts
A  src/ai/prompts/onboarding/csv-column-map.ts
A  src/app/s/[schoolSlug]/onboarding/import/_actions/suggestColumnMapping.ts
A  src/app/s/[schoolSlug]/onboarding/import/_components/AiMappingSuggestions.tsx
A  tests/integration/suggestColumnMapping.test.ts
A  tests/unit/aiMappingSuggestionsRender.test.ts
A  tests/unit/csvColumnMap.test.ts
A  tests/unit/hashStableInput.test.ts
A  tests/unit/saveAndExitChrome.test.ts
```

## What's deliberately deferred

- **Streaming AI suggestions.** The panel waits for the full
  response and renders ready / unavailable atomically. Streaming
  the per-column predictions would need a different action shape
  (server-sent events, not a single `tenantAction` return) and
  the operator-visible win is small at 10 columns × low latency.
- **Per-cell confidence on the manual pane.** Apply translates
  the AI draft into the page's mapping verbatim; the operator
  can't see "AI thinks this column is medium-confidence" once
  they've applied. The architectural seam (lifted `mapping`
  state) makes this trivial to add in a future sprint if the
  signal is wanted.
- **Re-suggesting after manual edits.** The panel fires once per
  fresh parse. An operator who adjusts a few mappings manually
  doesn't get a re-suggestion. The `headers` tuple is the
  dependency key, deliberately — the model's input hasn't changed,
  so a new call would be wasted.
- **Localised AI prompts.** The prompt is English-only and
  AU-locale-aware (DOB format expectations). Multi-locale support
  is a Sprint 9+ concern.
- **`HELP_URL` real value.** Carried forward from Sprint 4 / Chunk
  6. The placeholder still points at the contact page; the TODO
  comment is updated to `(Sprint 6)`. Awaits a real scheduling
  surface from Studio Parallel.

## What Sprint 6 plugs into

- **`HELP_URL`.** When Studio Parallel publishes a real "book a
  migration call" surface, the swap is one constant. The TODO
  comment carries the rationale forward verbatim.
- **AI suggestions on other surfaces.** The Levels and Skills
  steps already have `applyAssaDefaults` / `applyAssaSkillsForLevel`
  prompts (Sprint 4). The CSV mapping prompt is the third member
  of the family; future surfaces (e.g. "infer this class's level
  from its name") follow the same `PromptModule` shape and can
  reuse `hashStableInput`.
- **Re-running a previous mapping.** `import_batches.mapping`
  already stores the operator-confirmed mapping verbatim
  (Chunk 2). A "re-run last import with updated CSV" surface can
  pre-fill the new parse's mapping from the latest committed
  batch's record — the AI panel still fires (via the
  `headers.join` key) but the operator has a tested manual
  fallback ready.
- **Per-school template overrides.** A school-level "preferred
  CSV header naming" config (e.g. "Parent Email", not "Email")
  could be passed into the prompt as additional context. The
  `PromptModule` input type widens additively.

## Verification

```
prisma generate  ✓
tsc --noEmit     ✓ (no errors)
eslint           ✓ (5 pre-existing warnings, 0 errors — same
                    five carried since Sprint 4 / Chunk 1)
vitest           404 / 405 passed
                 (+ 22 new tests over Chunk 2's 382 / 383 baseline)

  The single failing test (tenantRouting "user with two
  memberships sees the picker") is the carry-forward from Sprint 4 /
  Chunk 1 — `cookies()` is called outside a request scope by the
  picker render. Confirmed by stashing this chunk's changes and
  re-running the same file: same failure on `main`. Same story as
  every Sprint 4 + Sprint 5 chunk handoff.
```

## Sprint 5 closeout

The whole sprint, walked end-to-end against its goal: a real
Onboarding flow whose terminal step actually completes the
wizard.

- ✅ **Classes step** — per-level accordion, location FK,
  ratio-bounded capacity, the count gate enforced both at the
  page (disable Continue) and the action (authoritative count
  inside `withTenant`). (Chunk 1.)
- ✅ **Teachers step** — Clerk invitations via the
  `pending_invitations` table, the XOR CHECK on
  `(teacher_id, pending_teacher_invitation_id)`, the atomic-swap
  pattern on invitation acceptance, the SECURITY DEFINER lookup
  for the sign-in-redirect path. (Chunk 1.)
- ✅ **Import step** — two-pane CSV importer (parse / dry-run /
  commit / rollback), four validation rule families,
  SAVEPOINT-based dry-run inside the open `withTenant`
  transaction, child-row tagging via nullable `batch_id` columns,
  externally-controllable `MappingPanel`. (Chunk 2.)
- ✅ **AI column-mapping suggestions** — Haiku-backed sidecar
  panel, three-state UI, graceful degradation, stable-key hashing
  on the cache surface. (Chunk 3 — this chunk.)
- ✅ **Wizard terminal step actually completes** — the
  `markImportComplete` save path enforces `countCommitted >= 1`
  and the journey test now asserts the redirect digest on both
  happy and skip paths. The Sprint 4 short-circuit at Skills →
  Classes is gone; the wizard walks Profile → Locations → Levels
  → Skills → Classes → Teachers → Import → Done. (Chunks 1 and 2;
  redirect assertion in this chunk.)
- ✅ **Save-and-exit covers every step.** The chrome `<Link>`
  inherited from Sprint 4 already covered every step; the
  contract test in this chunk pins the shape so a future
  refactor can't quietly remove it. (This chunk.)
- ✅ **Architecture doc updated.** The Onboarding section's
  Sprint 5 stub sub-section is replaced with three sub-sections
  (Classes / Teachers / Import) that describe what actually
  shipped. (This chunk.)
- 🔁 **`HELP_URL` real value** — carried forward from Sprint 4 /
  Chunk 6 unchanged. No real scheduling page has been published.
  Comment refreshed to `TODO(Sprint 6)`. (Decision-deferred:
  product input.)
- 🔁 **Pre-existing test failure** —
  `tests/integration/tenantRouting.test.ts > / landing page > user
  with two memberships sees the picker with both schools` continues
  to fail with `cookies was called outside a request scope`. Same
  flag as every chunk since Sprint 4 / Chunk 1. Not introduced by
  this sprint. A separate task can wire up the same `next/headers`
  mock pattern that the redirect tests already use.

The sprint shipped 405 tests (404 passing), up from the
pre-Sprint-5 baseline of 323. `tsc --noEmit` is clean. `npm run
lint` reports zero errors. The five lint warnings from Sprint 4
remain pre-existing.
