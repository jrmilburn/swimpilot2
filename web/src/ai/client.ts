import Anthropic from "@anthropic-ai/sdk";

// Lazy singleton. The first call to `getAnthropic()` constructs the client;
// subsequent calls return the cached instance. We don't construct at module
// import time because Next.js's build-time page-data collection imports
// route modules without running them, and we don't want missing env vars
// to break the build — only to break a real production request.
//
// In production we fail loudly the moment the SDK is asked for: an unset
// key would otherwise only surface inside the SDK's own auth-error code
// path, and we'd rather throw with a clear message at the wrapper layer.
function resolveApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "ANTHROPIC_API_KEY must be set in production. Check Vercel env vars.",
      );
    }
    return "";
  }
  return key;
}

const globalForAnthropic = globalThis as unknown as {
  anthropic?: Anthropic;
};

function createClient(): Anthropic {
  return new Anthropic({ apiKey: resolveApiKey() });
}

/**
 * Returns the cached Anthropic client, constructing it on first call. Only
 * `withAI` should reach for this — feature code calls `withAI`, not the
 * SDK directly (enforced by the ESLint boundary).
 */
export function getAnthropic(): Anthropic {
  if (!globalForAnthropic.anthropic) {
    globalForAnthropic.anthropic = createClient();
  }
  return globalForAnthropic.anthropic;
}

// Backwards-compatible export so `import { anthropic } from "./client"` keeps
// working in tests that mock this module via `vi.mock`. The Proxy defers
// every property access to a freshly-resolved client, so module-load tests
// don't trigger construction.
export const anthropic: Anthropic = new Proxy({} as Anthropic, {
  get(_target, prop, receiver) {
    return Reflect.get(getAnthropic(), prop, receiver);
  },
});
