"use client";

import { useActionState } from "react";
import {
  type ImportFormState,
  initialImportFormState,
  saveImportForm,
} from "../_actions/saveImportForm";

/**
 * Continue / Skip pair for the Import step. Both buttons call
 * `markImportComplete`, which flips `completed_at` and redirects to
 * the school dashboard. There's no real importer yet — Sprint 6
 * replaces this stub.
 */
export function ContinueControls({ schoolSlug }: { schoolSlug: string }) {
  const boundAction = saveImportForm.bind(null, schoolSlug);
  const [state, action, pending] = useActionState<ImportFormState, FormData>(
    boundAction,
    initialImportFormState,
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
          disabled={pending}
          className="rounded-full bg-foreground px-5 py-2 text-sm text-background disabled:opacity-50"
        >
          {pending ? "Finishing…" : "Finish setup"}
        </button>
      </div>
    </form>
  );
}
