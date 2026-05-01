import Link from "next/link";
import { ContinueControls } from "./ContinueControls";

/**
 * Disabled state for the Skills step when the operator has no levels.
 * Skills attach to levels — the wizard can't render the accordion
 * without at least one. We surface a "go back" affordance to Levels and
 * a Skip button (the only forward action available) so the operator
 * isn't trapped on a blank page.
 *
 * Per the handoff: don't render an inline "add a level" form here.
 * Adding a level requires the levels page's full machinery (ASSA
 * prompt, sample preview, ratio fields). Linking back is the honest UX.
 */
export function SkillsBlockedByLevels({ schoolSlug }: { schoolSlug: string }) {
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3 rounded-md border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
        <h3 className="text-base font-semibold tracking-tight">
          You&apos;ll need at least one level first
        </h3>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Skills attach to levels — without one, there&apos;s no place
          to file your curriculum. Head back to the Levels step to add
          one (or pick the ASSA defaults), then return here.
        </p>
        <div>
          <Link
            href={`/s/${schoolSlug}/onboarding/levels`}
            className="inline-block rounded-full bg-foreground px-4 py-2 text-sm text-background"
          >
            Add a level first
          </Link>
        </div>
      </section>

      <ContinueControls schoolSlug={schoolSlug} hideSave />
    </div>
  );
}
