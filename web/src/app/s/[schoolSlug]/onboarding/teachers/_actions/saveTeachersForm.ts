"use server";

import { redirect } from "next/navigation";
import { OnboardingStep } from "@/domain/enums";
import { nextStepAfter } from "@/domain/onboarding";
import { markTeachersComplete } from "./markTeachersComplete";

export type TeachersFormState = {
  message: string | null;
  fieldErrors: Partial<Record<"_form", string>>;
};

export const initialTeachersFormState: TeachersFormState = {
  message: null,
  fieldErrors: {},
};

/**
 * `useActionState` bridge for the Teachers step's Continue / Skip
 * buttons. Both intents dispatch to `markTeachersComplete`, which
 * advances `current_step` to Import — the wizard's final step under
 * the Sprint 5 / Chunk 1 ordering.
 */
export async function saveTeachersForm(
  schoolSlug: string,
  _prev: TeachersFormState,
  formData: FormData,
): Promise<TeachersFormState> {
  const intent = formData.get("intent");
  const skip = intent === "skip";

  const result = await markTeachersComplete({ skip });

  if (!result.ok) {
    if (result.error.code === "VALIDATION") {
      const msg = result.error.message;
      return {
        message: msg,
        fieldErrors: result.error.fieldErrors
          ? (result.error.fieldErrors as TeachersFormState["fieldErrors"])
          : { _form: msg },
      };
    }
    return {
      message: result.error.message,
      fieldErrors: { _form: result.error.message },
    };
  }

  redirect(
    `/s/${schoolSlug}/onboarding/${nextStepAfter(OnboardingStep.Teachers)}`,
  );
}
