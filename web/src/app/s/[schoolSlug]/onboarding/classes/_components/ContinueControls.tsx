"use client";

import { useActionState } from "react";
import {
  type ClassesFormState,
  initialClassesFormState,
  saveClassesForm,
} from "../_actions/saveClassesForm";

/**
 * The single Continue / Skip pair for the Classes step. Lives below
 * the accordion. Mirrors `ContinueControls` from the Skills step.
 *
 * `disableSave` is set by the page when the school has zero classes:
 * `markClassesComplete` requires ≥ 1 class on the save path, so
 * disabling the button locally avoids a round-trip to learn the gate.
 * Skip is always enabled.
 */
export function ContinueControls({
  schoolSlug,
  disableSave,
}: {
  schoolSlug: string;
  disableSave: boolean;
}) {
  const boundAction = saveClassesForm.bind(null, schoolSlug);
  const [state, action, pending] = useActionState<ClassesFormState, FormData>(
    boundAction,
    initialClassesFormState,
  );

  return (
    <form
      action={action}
      className="flex flex-col items-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800"
    >
      {state.fieldErrors._form ? (
        <div
          role="alert"
          className="w-full rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
        >
          {state.fieldErrors._form}
        </div>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          name="intent"
          value="skip"
          disabled={pending}
          className="rounded-full border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
        >
          {pending ? "Working…" : "Skip for now"}
        </button>
        <button
          type="submit"
          name="intent"
          value="save"
          disabled={pending || disableSave}
          className="rounded-full bg-foreground px-5 py-2 text-sm text-background disabled:opacity-50"
        >
          {pending ? "Saving…" : "Continue"}
        </button>
      </div>
    </form>
  );
}
