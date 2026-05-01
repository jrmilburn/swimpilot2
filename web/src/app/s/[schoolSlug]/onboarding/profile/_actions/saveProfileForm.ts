"use server";

import { redirect } from "next/navigation";
import { OnboardingStep } from "@/domain/enums";
import { nextStepAfter } from "@/domain/onboarding";
import { markProfileComplete } from "./markProfileComplete";

// Field-keyed validation error map. Keeping this granular (rather than
// one global message) lets the form render an inline error next to the
// input that failed.
export type ProfileFormState = {
  message: string | null;
  fieldErrors: Partial<
    Record<
      | "legalName"
      | "tradingName"
      | "abn"
      | "primaryContactName"
      | "primaryContactEmail"
      | "primaryContactPhone"
      | "logoUrl"
      | "_form",
      string
    >
  >;
};

export const initialProfileFormState: ProfileFormState = {
  message: null,
  fieldErrors: {},
};

function readString(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The bridge between the React form and `markProfileComplete`. The form
 * uses `useActionState`, which gives us `(prevState, formData)` —
 * dispatch into the typed action, return field-keyed error state on
 * validation failure, and redirect to the next wizard step on success.
 *
 * Why both `save` and `skip` flow through one action: the wizard's
 * "Skip" button posts the same form with `intent=skip`. One action keeps
 * the page-level redirect logic in one place and matches the Chunk 1
 * generic shape — Chunks 3–5 will copy this.
 */
export async function saveProfileForm(
  schoolSlug: string,
  _prev: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const intent = formData.get("intent");
  const skip = intent === "skip";

  const input = skip
    ? { skip: true as const }
    : {
        skip: false as const,
        legalName: readString(formData, "legalName"),
        tradingName: readString(formData, "tradingName"),
        abn: readString(formData, "abn"),
        gstRegistered: formData.get("gstRegistered") === "yes",
        primaryContactName: readString(formData, "primaryContactName"),
        primaryContactEmail: readString(formData, "primaryContactEmail"),
        primaryContactPhone: readString(formData, "primaryContactPhone"),
        logoUrl: readString(formData, "logoUrl"),
      };

  const result = await markProfileComplete(input);

  if (!result.ok) {
    if (result.error.code === "VALIDATION") {
      // Prefer the typed `fieldErrors` map promoted in Chunk 3. Fall
      // back to the substring heuristic for any throw site that hasn't
      // been migrated — both call shapes are supported in parallel so
      // we don't have to reach every site at once.
      const msg = result.error.message;
      if (result.error.fieldErrors) {
        return {
          message: msg,
          fieldErrors: result.error
            .fieldErrors as ProfileFormState["fieldErrors"],
        };
      }
      const fieldErrors: ProfileFormState["fieldErrors"] = {};
      if (/abn/i.test(msg)) fieldErrors.abn = msg;
      else if (/email/i.test(msg)) fieldErrors.primaryContactEmail = msg;
      else fieldErrors._form = msg;
      return { message: msg, fieldErrors };
    }
    return {
      message: result.error.message,
      fieldErrors: { _form: result.error.message },
    };
  }

  // Success: redirect into the next wizard step. Profile is the first
  // step so `completedWizard` is always false here, but checking
  // preserves the Chunk 1 contract for chunks that copy this shape.
  if (result.data.completedWizard) {
    redirect(`/s/${schoolSlug}`);
  }
  redirect(
    `/s/${schoolSlug}/onboarding/${nextStepAfter(OnboardingStep.Profile)}`,
  );
}
