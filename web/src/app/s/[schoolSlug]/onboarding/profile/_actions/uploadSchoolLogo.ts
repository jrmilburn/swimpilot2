"use server";

import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import * as assetRepository from "@/repositories/assetRepository";

// Hard-coded limits matching the profile form's logo control. Anything
// outside these is rejected at the action boundary so the upload never
// touches Storage. Cropping / image transforms are out of scope for
// Chunk 2 — the file is stored as-is.
const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED_CONTENT_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export type UploadSchoolLogoResult = { path: string };

/**
 * Upload a school logo to Supabase Storage.
 *
 * The action:
 *   1. is `tenantAction`-wrapped so the slug header gates which school's
 *      bucket prefix we write to. The caller cannot smuggle a school_id;
 *      `assetRepository.uploadSchoolAsset` reads it from the resolved
 *      tenant context.
 *   2. validates content-type and size at the boundary.
 *   3. returns only the storage path. Persisting the path to the
 *      `schools.logo_url` column is the form-submit's job, NOT this
 *      action's. Two reasons: (a) a user might upload then cancel the
 *      form, and we don't want a half-saved row pointing at the new
 *      asset; (b) the path travels through a hidden form field, so
 *      keeping the upload separate from the entity write means the
 *      existing form mechanic Just Works.
 *
 * Logo deletion / replacement UX is deferred — saving over a path leaves
 * the previous Storage object orphaned. A scheduled-cleanup job is the
 * right shape for that, not a per-request delete; see the chunk handoff.
 */
export const uploadSchoolLogo = tenantAction(
  async ({ tx, schoolId }, formData: FormData): Promise<UploadSchoolLogoResult> => {
    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new ValidationError("No file provided");
    }
    if (file.size === 0) {
      throw new ValidationError("File is empty");
    }
    if (file.size > MAX_LOGO_BYTES) {
      throw new ValidationError("Logo must be 2MB or smaller");
    }
    if (!ALLOWED_CONTENT_TYPES.has(file.type)) {
      throw new ValidationError(
        "Logo must be a PNG, JPEG, or WEBP image",
      );
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const path = await assetRepository.uploadSchoolAsset(tx, {
      schoolId,
      assetType: "logo",
      file: buf,
      contentType: file.type,
    });
    return { path };
  },
);
