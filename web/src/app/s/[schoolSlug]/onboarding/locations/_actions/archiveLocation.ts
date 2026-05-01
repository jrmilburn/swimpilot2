"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import * as locationRepository from "@/repositories/locationRepository";

const Input = z.object({ id: z.uuid("Invalid location id") });

/**
 * Soft-delete a location. Idempotent: archiving an already-archived row
 * is a silent no-op (the existing `deleted_at` timestamp is preserved).
 * Cross-tenant calls (slug A, location id from B) read null from
 * `getById` because RLS hides B's row, and we silently no-op on null
 * too — there is nothing to leak. The alternative (raising
 * NotFoundError) would let a caller probe for ids across tenants.
 *
 * Returns `{ archived }` so the caller can distinguish "we just
 * archived this" from "no-op". The wizard UI doesn't need the
 * distinction today; tests check the return shape.
 */
export const archiveLocation = tenantAction(
  async ({ tx }, input: unknown) => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Invalid location id");
    }
    const { id } = parsed.data;

    const existing = await locationRepository.getById(tx, id);
    if (!existing) {
      // `getById` returns null both for genuinely missing rows and for
      // rows already soft-deleted (the repository hides them) — either
      // way we have nothing to archive. Silent no-op.
      return { archived: false } as const;
    }

    await locationRepository.archive(tx, id);

    revalidatePath("/s/[schoolSlug]/onboarding/locations", "page");

    return { archived: true } as const;
  },
);
