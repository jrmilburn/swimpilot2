// Shared types every prompt module and call site uses. Importing the
// Anthropic SDK here is allowed — this directory is the only place that
// can — but we keep this file dependency-light by referring to it as a
// type only, so future prompt authors don't need to think about SDK
// imports just to declare a prompt.

export interface PromptResult {
  system: string;
  user: string;
  model: string;
  maxTokens: number;
}

/**
 * A prompt is a function, not a string. The call site never sees raw prompt
 * text — it passes a typed input to the prompt's `build` and gets a
 * `PromptResult` back inside `withAI`. The registry of prompt modules is
 * the single surface where prompt content lives, which means evals,
 * versioning, and content audits all have one place to instrument later.
 *
 * `name` and `version` are stamped into the `ai_calls` log row so we can
 * group calls by prompt across runs. Bump `version` manually when the
 * `build` function's output meaningfully changes.
 */
export interface PromptModule<TInput> {
  name: string;
  version: number;
  build: (input: TInput) => PromptResult;
}

/**
 * Captured by `withAI` from AsyncLocalStorage at the moment a call is made.
 * Not generally constructed by callers.
 */
export interface AICallContext {
  feature: string;
  schoolId: string;
  userId: string | null;
}
