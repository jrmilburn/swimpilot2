"use server";

import { revalidatePath } from "next/cache";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import * as locationRepository from "@/repositories/locationRepository";
import { CreateLocationSchema } from "./locationFields";

/**
 * Create a single location for the current tenant. Returns the created
 * row so the caller can reflect the new id without a re-fetch — though
 * the wizard's pattern is to revalidate the page and let the server
 * component re-render the list, so the returned row is mostly a
 * convenience for tests.
 *
 * Per-row actions are deliberately separate from `markLocationsComplete`:
 * the step-advance form uses `useActionState` for inline validation, and
 * the per-row buttons trigger their own actions + revalidate. Bundling
 * everything through one big form would push a list-of-N into
 * `useActionState` (whose state cycle doesn't carry binary inputs and
 * doesn't compose well with N inline editors).
 */
export const addLocation = tenantAction(async ({ tx }, input: unknown) => {
  const parsed = CreateLocationSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path[0];
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
  const data = parsed.data;
  const created = await locationRepository.create(tx, {
    name: data.name,
    addressLine: data.addressLine,
    suburb: data.suburb,
    state: data.state,
    postcode: data.postcode,
    timezone: data.timezone,
    notes: data.notes,
  });

  // The page server-component re-reads the location list inside
  // withTenant on each render, so the only thing we need to do here is
  // bust Next's segment cache. revalidatePath rather than revalidateTag
  // because the wizard page has no tagged data sources today.
  revalidatePath("/s/[schoolSlug]/onboarding/locations", "page");

  return created;
});
