"use server";

import { redirect } from "next/navigation";
import { OnboardingStep } from "@/domain/enums";
import { nextStepAfter } from "@/domain/onboarding";
import { markClassesComplete } from "./markClassesComplete";

export type ClassesFormState = {
  message: string | null;
  fieldErrors: Partial<Record<"_form", string>>;
};

export const initialClassesFormState: ClassesFormState = {
  message: null,
  fieldErrors: {},
};

/**
 * `useActionState` bridge for the Classes step's Continue / Skip
 * buttons. Reads the `intent` button (`save` / `skip`), dispatches to
 * `markClassesComplete`, and redirects on success.
 *
 * `markClassesComplete` returns `completedWizard: false` for both
 * paths — Sprint 5+ chunks ship Teachers, Import, Billing and Channels,
 * none of which complete the wizard either. The Import stub is the
 * single seam that flips `completed_at` on the wizard, mirroring the
 * Sprint 4 Skills→Classes flow.
 */
export async function saveClassesForm(
  schoolSlug: string,
  _prev: ClassesFormState,
  formData: FormData,
): Promise<ClassesFormState> {
  const intent = formData.get("intent");
  const skip = intent === "skip";

  const result = await markClassesComplete({ skip });

  if (!result.ok) {
    if (result.error.code === "VALIDATION") {
      const msg = result.error.message;
      return {
        message: msg,
        fieldErrors: result.error.fieldErrors
          ? (result.error.fieldErrors as ClassesFormState["fieldErrors"])
          : { _form: msg },
      };
    }
    return {
      message: result.error.message,
      fieldErrors: { _form: result.error.message },
    };
  }

  redirect(
    `/s/${schoolSlug}/onboarding/${nextStepAfter(OnboardingStep.Classes)}`,
  );
}
