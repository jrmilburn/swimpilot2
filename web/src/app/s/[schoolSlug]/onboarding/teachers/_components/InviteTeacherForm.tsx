"use client";

import { useState, useTransition } from "react";
import { inviteTeacher } from "../_actions/inviteTeacher";

/**
 * Inline form for inviting a single teacher. Email-only — Clerk asks
 * for the rest of the profile (name, password) at sign-up time, and
 * "name now, name again later" is friction we don't need.
 *
 * On success the page revalidates and the new pending row appears in
 * the roster below — the form resets ready for the next invite. On
 * VALIDATION errors with a `fieldErrors.email` we surface the field
 * error inline; `_form` errors render in a banner.
 */
export function InviteTeacherForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<{
    message: string;
    fields?: Record<string, string>;
  } | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await inviteTeacher({ email });
      if (!result.ok) {
        setError({
          message: result.error.message,
          fields:
            result.error.code === "VALIDATION"
              ? result.error.fieldErrors
              : undefined,
        });
        return;
      }
      setEmail("");
    });
  }

  const fieldErr = error?.fields?.email;
  const formErr = error && !error.fields ? error.message : error?.fields?._form;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <h3 className="text-sm font-medium">Invite a teacher</h3>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        We&apos;ll email them a sign-up link. Once they sign up, their
        membership is finalised automatically and any classes you parked
        on the invite move to them.
      </p>
      {formErr ? (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
        >
          {formErr}
        </div>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teacher@example.com"
            className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          />
          {fieldErr ? (
            <span className="text-xs text-red-600 dark:text-red-400" role="alert">
              {fieldErr}
            </span>
          ) : null}
        </label>
        <button
          type="button"
          onClick={submit}
          disabled={pending || email.trim() === ""}
          className="rounded-full bg-foreground px-4 py-2 text-sm text-background disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send invite"}
        </button>
      </div>
    </div>
  );
}
