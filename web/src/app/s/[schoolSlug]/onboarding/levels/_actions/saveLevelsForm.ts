"use server";

import { redirect } from "next/navigation";
import { OnboardingStep } from "@/domain/enums";
import { nextStepAfter } from "@/domain/onboarding";
import { markLevelsComplete } from "./markLevelsComplete";

// `_form` is the only key for now — name / age validation lives on the
// per-row add/update actions, not this bridge. Skill template caveat is
// shown next to the Skip button via plain copy in `LevelsList`.
export type LevelsFormState = {
  message: string | null;
  fieldErrors: Partial<Record<"_form", string>>;
};

export const initialLevelsFormState: LevelsFormState = {
  message: null,
  fieldErrors: {},
};

/**
 * `useActionState` bridge for the step-advance buttons. Reads the
 * `intent` button (`save` / `skip`) and dispatches to the typed
 * discriminated-union action. Mirrors `saveLocationsForm` (Chunk 3) and
 * `saveProfileForm` (Chunk 2).
 */
export async function saveLevelsForm(
  schoolSlug: string,
  _prev: LevelsFormState,
  formData: FormData,
): Promise<LevelsFormState> {
  const intent = formData.get("intent");
  const skip = intent === "skip";

  const result = await markLevelsComplete({ skip });

  if (!result.ok) {
    if (result.error.code === "VALIDATION") {
      const msg = result.error.message;
      return {
        message: msg,
        fieldErrors: result.error.fieldErrors
          ? (result.error.fieldErrors as LevelsFormState["fieldErrors"])
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
    `/s/${schoolSlug}/onboarding/${nextStepAfter(OnboardingStep.Levels)}`,
  );
}
