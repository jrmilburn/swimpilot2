"use server";

import { redirect } from "next/navigation";
import { OnboardingStep } from "@/domain/enums";
import { nextStepAfter } from "@/domain/onboarding";
import { markSkillsComplete } from "./markSkillsComplete";

// `_form` is the only key. Per-row name validation lives on add/update,
// not this bridge. Skills' Continue is enabled regardless of whether any
// skills are saved — the spec allows a "completed Skills with empty
// levels" state — so the gate that surfaces here is, in practice, only
// "the markSkillsComplete action returned a non-VALIDATION error" or a
// validation that comes from the input schema rather than a count gate.
export type SkillsFormState = {
  message: string | null;
  fieldErrors: Partial<Record<"_form", string>>;
};

export const initialSkillsFormState: SkillsFormState = {
  message: null,
  fieldErrors: {},
};

/**
 * `useActionState` bridge for the step-advance buttons. Reads the
 * `intent` button (`save` / `skip`) and dispatches to the typed
 * discriminated-union action. Mirrors `saveLevelsForm` (Chunk 4).
 *
 * Both save and skip advance to `/onboarding/classes` (the Sprint 5
 * stub). `markSkillsComplete` returns `completedWizard: false`; the
 * dashboard branch is here for symmetry with the other per-step
 * bridges, not because Skills can complete the wizard.
 */
export async function saveSkillsForm(
  schoolSlug: string,
  _prev: SkillsFormState,
  formData: FormData,
): Promise<SkillsFormState> {
  const intent = formData.get("intent");
  const skip = intent === "skip";

  const result = await markSkillsComplete({ skip });

  if (!result.ok) {
    if (result.error.code === "VALIDATION") {
      const msg = result.error.message;
      return {
        message: msg,
        fieldErrors: result.error.fieldErrors
          ? (result.error.fieldErrors as SkillsFormState["fieldErrors"])
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
    `/s/${schoolSlug}/onboarding/${nextStepAfter(OnboardingStep.Skills)}`,
  );
}
