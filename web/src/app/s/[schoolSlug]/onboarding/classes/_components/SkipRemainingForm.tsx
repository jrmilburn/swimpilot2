import { submitSkipRemaining } from "../_actions/submitSkipRemaining";

/**
 * Single-button form on the Classes stub. Server component — there's no
 * inline validation to surface, so no `useActionState` is needed. The
 * bound action redirects on success.
 */
export function SkipRemainingForm({ schoolSlug }: { schoolSlug: string }) {
  const action = submitSkipRemaining.bind(null, schoolSlug);
  return (
    <form action={action}>
      <button
        type="submit"
        className="rounded-full bg-foreground px-4 py-2 text-sm text-background"
      >
        Skip the rest of onboarding for now
      </button>
    </form>
  );
}
