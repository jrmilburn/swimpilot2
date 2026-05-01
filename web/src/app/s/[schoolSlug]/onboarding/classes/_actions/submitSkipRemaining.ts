"use server";

import { redirect } from "next/navigation";
import { skipRemainingOnboarding } from "./skipRemainingOnboarding";

/**
 * `<form action>` bridge for the "Skip the rest of onboarding for now"
 * button on the `/onboarding/classes` stub. Calls the typed action and
 * redirects to the dashboard on success.
 *
 * This bridge has no `useActionState` because the stub has no field
 * errors to surface — there's no input. A typed `INTERNAL` failure from
 * `tenantAction` would re-render the stub with no feedback; that's
 * acceptable for a placeholder, and Sprint 5's real step replaces this
 * page outright.
 */
export async function submitSkipRemaining(schoolSlug: string): Promise<void> {
  const result = await skipRemainingOnboarding();
  if (!result.ok) {
    // The action only fails on tenant-resolution / RLS issues here —
    // nothing the user can fix from this surface. Re-render with no
    // change; the user can retry.
    return;
  }
  redirect(`/s/${schoolSlug}`);
}
