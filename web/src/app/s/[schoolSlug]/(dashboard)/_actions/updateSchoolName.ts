"use server";

import { z } from "zod";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import * as schoolRepository from "@/repositories/schoolRepository";

const Input = z.object({ name: z.string().min(1).max(120) });

/**
 * Reference example for `tenantAction`.
 *
 * Walks the canonical flow end-to-end:
 *   1. middleware sets `x-school-slug` from the URL
 *   2. `tenantAction` reads it, calls `requireTenant`, opens `withTenant`
 *   3. our body validates input, then calls a repository with `tx`
 *   4. RLS scopes the update; the audit extension stamps `updated_by`
 *
 * Throws `ValidationError` for bad input — the wrapper maps it to
 * `{ ok: false, error: { code: "VALIDATION", … } }`.
 */
export const updateSchoolName = tenantAction(
  async ({ tx, schoolId }, input: unknown) => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Invalid school name");
    }
    return schoolRepository.update(tx, schoolId, { name: parsed.data.name });
  },
);
