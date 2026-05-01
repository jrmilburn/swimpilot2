"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { tenantAction } from "@/lib/auth/tenantAction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import * as locationRepository from "@/repositories/locationRepository";
import { UpdateLocationSchema } from "./locationFields";

const Input = z.object({
  id: z.uuid("Invalid location id"),
  patch: UpdateLocationSchema,
});

/**
 * Partial update on one location row. RLS scopes the read inside
 * `getById`; if the id doesn't belong to the current tenant the read
 * returns null and we throw `NotFoundError` before attempting the
 * write. That is the cross-tenant defence — `update` itself would also
 * be rejected by the RLS UPDATE policy, but failing earlier produces a
 * cleaner action result.
 */
export const updateLocation = tenantAction(
  async ({ tx }, input: unknown) => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path[issue.path.length - 1];
        if (typeof path === "string" && !fieldErrors[path]) {
          fieldErrors[path] = issue.message;
        }
      }
      const first = parsed.error.issues[0];
      throw new ValidationError(
        first?.message ?? "Invalid location",
        fieldErrors,
      );
    }
    const { id, patch } = parsed.data;

    const existing = await locationRepository.getById(tx, id);
    if (!existing) {
      throw new NotFoundError("Location not found");
    }

    const updated = await locationRepository.update(tx, id, patch);

    revalidatePath("/s/[schoolSlug]/onboarding/locations", "page");

    return updated;
  },
);
