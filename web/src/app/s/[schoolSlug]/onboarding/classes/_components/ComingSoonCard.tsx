import Link from "next/link";
import { SkipRemainingForm } from "./SkipRemainingForm";

/**
 * Sprint 5 stub card for the Classes step. Tells the operator the real
 * step is in flight, lets them either step back to Skills or finish
 * onboarding now and come back later.
 *
 * Scaffolding intentionally duplicates `SkillsBlockedByLevels` from
 * Chunk 5 rather than parameterising — the Sprint 5 chunk that ships
 * the real Classes step will replace this file outright, and a shared
 * component would only be one indirection in the way.
 */
export function ComingSoonCard({ schoolSlug }: { schoolSlug: string }) {
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3 rounded-md border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
        <h3 className="text-base font-semibold tracking-tight">
          Classes — coming soon
        </h3>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          We&apos;re still building the Classes step. You can finish
          onboarding for now and come back to set up your class schedule
          once Sprint 5 ships — your locations, levels, and skills are
          already saved.
        </p>
        <div className="flex flex-wrap gap-2 pt-2">
          <Link
            href={`/s/${schoolSlug}/onboarding/skills`}
            className="rounded-full border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
          >
            Back to Skills
          </Link>
          <SkipRemainingForm schoolSlug={schoolSlug} />
        </div>
      </section>
    </div>
  );
}
