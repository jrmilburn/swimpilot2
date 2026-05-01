"use client";

import { useActionState } from "react";
import {
  type SkillsFormState,
  initialSkillsFormState,
  saveSkillsForm,
} from "../_actions/saveSkillsForm";

/**
 * The single Continue / Skip pair for the Skills step. Lives below the
 * accordion (or alongside the blocked state) — there is exactly one of
 * these per page, never one per accordion section. Per-section controls
 * would produce contradictory submission states; the spec is explicit
 * about avoiding that.
 *
 * `hideSave` is set by `SkillsBlockedByLevels` when the operator has no
 * levels: the save path requires an accordion to render and the spec
 * hides Continue in that branch. Skip is always available so the
 * operator can advance the wizard regardless.
 *
 * Continue is enabled even when no skills have been saved — the spec
 * allows a "completed Skills with empty levels" state. The action layer
 * has no count gate.
 */
export function ContinueControls({
  schoolSlug,
  hideSave = false,
}: {
  schoolSlug: string;
  hideSave?: boolean;
}) {
  const boundAction = saveSkillsForm.bind(null, schoolSlug);
  const [state, action, pending] = useActionState<SkillsFormState, FormData>(
    boundAction,
    initialSkillsFormState,
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
        {hideSave ? null : (
          <button
            type="submit"
            name="intent"
            value="save"
            disabled={pending}
            className="rounded-full bg-foreground px-5 py-2 text-sm text-background disabled:opacity-50"
          >
            {pending ? "Saving…" : "Continue"}
          </button>
        )}
      </div>
    </form>
  );
}
