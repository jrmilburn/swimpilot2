"use server";

import { redirect } from "next/navigation";
import { OnboardingStep } from "@/domain/enums";
import { nextStepAfter } from "@/domain/onboarding";
import { markLocationsComplete } from "./markLocationsComplete";

// Field-keyed validation error map. `_form` is the only key today —
// `markLocationsComplete` raises a single global "at least one
// location required" message. Per-row validation lands inline in the
// add/update actions, not here.
export type LocationsFormState = {
  message: string | null;
  fieldErrors: Partial<Record<"_form", string>>;
};

export const initialLocationsFormState: LocationsFormState = {
  message: null,
  fieldErrors: {},
};

/**
 * `useActionState` bridge for the step-advance Continue button. Built
 * on the typed `fieldErrors` shape promoted in Chunk 3 — no substring
 * heuristic.
 *
 * The form posts no data: per-row mutations are handled by separate
 * actions (`addLocation` / `updateLocation` / `archiveLocation`) that
 * `revalidatePath` and let the page re-render. This bridge's only
 * job is to call `markLocationsComplete` and redirect.
 */
export async function saveLocationsForm(
  schoolSlug: string,
  _prev: LocationsFormState,
  _formData: FormData,
): Promise<LocationsFormState> {
  const result = await markLocationsComplete();

  if (!result.ok) {
    if (result.error.code === "VALIDATION") {
      const msg = result.error.message;
      return {
        message: msg,
        fieldErrors: result.error.fieldErrors
          ? (result.error.fieldErrors as LocationsFormState["fieldErrors"])
          : { _form: msg },
      };
    }
    return {
      message: result.error.message,
      fieldErrors: { _form: result.error.message },
    };
  }

  if (result.data.completedWizard) {
    redirect(`/s/${schoolSlug}`);
  }
  redirect(
    `/s/${schoolSlug}/onboarding/${nextStepAfter(OnboardingStep.Locations)}`,
  );
}
