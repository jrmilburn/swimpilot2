import { randomUUID } from "node:crypto";
import { prisma } from "../lib/db/client";
import type { TenantTx } from "../lib/db/withTenant";
import {
  SCHOOL_ASSETS_BUCKET,
  getStorageClient,
} from "../lib/storage/client";

// Asset repository: a thin surface over Supabase Storage. Logos this chunk;
// Sprint 7 (skill photos) and Sprint 8 (invoice PDFs) will reuse it without
// going through the wrong aggregate. Logo / photo / PDF storage is
// orthogonal to the school's row data — keep it on its own surface.
//
// The `db` argument is unused today but kept on the function signature so
// the repository layer's "first arg is a DbClient" contract holds, and so
// a future `uploads` audit table (Sprint 9+) can join into the same
// transaction without reshuffling every call site.

export type DbClient = TenantTx | typeof prisma;

export type SchoolAssetType = "logo" | "skill-photo" | "invoice";

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

/**
 * Upload a binary asset under the school's prefix and return the storage
 * path. The path layout is `<school_id>/<assetType>/<uuid>.<ext>` —
 * tenant-scoping is enforced by the application constructing the path,
 * not by Storage RLS (the service-role key bypasses that). Callers must
 * never pass a path or filename derived from user input; the function
 * deliberately doesn't take one.
 *
 * Returns the path. Persisting the path to a row (e.g. `schools.logo_url`)
 * is the caller's job — the upload action and the entity write are
 * intentionally split so a user can upload, abandon the form, and not
 * leave a half-saved row pointing at the new asset.
 */
export async function uploadSchoolAsset(
  _db: DbClient,
  args: {
    schoolId: string;
    assetType: SchoolAssetType;
    file: ArrayBuffer | Uint8Array | Buffer;
    contentType: string;
  },
): Promise<string> {
  const ext = EXTENSION_BY_CONTENT_TYPE[args.contentType];
  if (!ext) {
    throw new Error(
      `assetRepository: unsupported contentType ${args.contentType}`,
    );
  }
  const path = `${args.schoolId}/${args.assetType}/${randomUUID()}.${ext}`;

  const storage = getStorageClient();
  const { error } = await storage.storage
    .from(SCHOOL_ASSETS_BUCKET)
    .upload(path, args.file as Buffer, {
      contentType: args.contentType,
      upsert: false,
    });

  if (error) {
    throw new Error(`assetRepository: upload failed: ${error.message}`);
  }
  return path;
}

/**
 * Sign a short-lived URL for a stored path. Caller picks the TTL — the
 * default of one hour is the operator-facing UI's working assumption
 * (long enough that a slow page render or a user revisiting the wizard
 * doesn't break the preview, short enough that a leaked URL stops
 * working before it can do real damage).
 */
export async function signSchoolAssetUrl(
  path: string,
  ttlSeconds: number = 60 * 60,
): Promise<string> {
  const storage = getStorageClient();
  const { data, error } = await storage.storage
    .from(SCHOOL_ASSETS_BUCKET)
    .createSignedUrl(path, ttlSeconds);

  if (error || !data) {
    throw new Error(
      `assetRepository: sign failed: ${error?.message ?? "no data"}`,
    );
  }
  return data.signedUrl;
}

/**
 * Delete a stored asset. Idempotent on file-not-found: a row may point
 * at a path that's already been cleaned up, and a second wizard pass
 * shouldn't fail because the orphan was tidied. Other Storage errors
 * still throw.
 */
export async function deleteSchoolAsset(path: string): Promise<void> {
  const storage = getStorageClient();
  const { error } = await storage.storage
    .from(SCHOOL_ASSETS_BUCKET)
    .remove([path]);
  if (!error) return;
  // Supabase returns a generic message on missing keys; treat any
  // not-found-ish error as a no-op rather than tightly coupling to the
  // exact wording.
  if (/not.?found/i.test(error.message)) return;
  throw new Error(`assetRepository: delete failed: ${error.message}`);
}
