import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Service-role Supabase client used for Storage uploads, signed URLs, and
// deletes. Service-role bypasses Supabase's own RLS on Storage — that is
// why this client is restricted to `src/lib/storage/**` (the construction
// site) and `src/repositories/**` (the consumption site) by an ESLint rule
// matching the Prisma boundary. File paths are tenant-scoped only because
// the application (`assetRepository`) constructs them with `school_id`;
// any code path that lets a user pick the path is a tenant-bypass bug.
//
// Environment variables:
// - `NEXT_PUBLIC_SUPABASE_URL` — the project URL. Public.
// - `SUPABASE_SERVICE_ROLE_KEY` — secret. NEVER ship to the client.
//
// In production we fail loudly at first construction if either is missing
// rather than silently degrading uploads. In dev / test we tolerate the
// absence so feature-unrelated tests don't have to set the keys; the
// storage path is only exercised by `uploadSchoolLogo`, which the
// integration tests mock at the boundary.

let cached: SupabaseClient | null = null;

export class StorageNotConfiguredError extends Error {
  constructor(message = "Supabase Storage is not configured") {
    super(message);
    this.name = "StorageNotConfiguredError";
  }
}

function buildClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    if (process.env.NODE_ENV === "production") {
      throw new StorageNotConfiguredError(
        "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before deploying.",
      );
    }
    throw new StorageNotConfiguredError(
      "Supabase Storage env vars missing (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY). " +
        "Set them in `.env` to use the logo-upload flow locally.",
    );
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function getStorageClient(): SupabaseClient {
  if (!cached) {
    cached = buildClient();
  }
  return cached;
}

// Test seam: lets `tests/integration/uploadSchoolLogo.test.ts` install a
// mock client without spinning up a real Supabase instance. Production
// code never calls this.
export function __setStorageClientForTesting(client: SupabaseClient | null) {
  cached = client;
}

export const SCHOOL_ASSETS_BUCKET = "school-assets";
