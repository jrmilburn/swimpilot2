"use server";

import { redirect } from "next/navigation";
import { markImportComplete } from "./markImportComplete";

export type ImportFormState = {
  message: string | null;
  fieldErrors: Partial<Record<"_form", string>>;
};

export const initialImportFormState: ImportFormState = {
  message: null,
  fieldErrors: {},
};

/**
 * `useActionState` bridge for the Import step. Both Continue and Skip
 * call `markImportComplete`, which is the seam that flips
 * `onboarding_progress.completed_at`. On success we redirect into the
 * school dashboard instead of advancing through `nextStepAfter` —
 * Import is the wizard's tail under the Sprint 5 / Chunk 1 ordering.
 */
export async function saveImportForm(
  schoolSlug: string,
  _prev: ImportFormState,
  formData: FormData,
): Promise<ImportFormState> {
  const intent = formData.get("intent");
  const skip = intent === "skip";

  const result = await markImportComplete({ skip });

  if (!result.ok) {
    if (result.error.code === "VALIDATION") {
      const msg = result.error.message;
      return {
        message: msg,
        fieldErrors: result.error.fieldErrors
          ? (result.error.fieldErrors as ImportFormState["fieldErrors"])
          : { _form: msg },
      };
    }
    return {
      message: result.error.message,
      fieldErrors: { _form: result.error.message },
    };
  }

  redirect(`/s/${schoolSlug}`);
}
