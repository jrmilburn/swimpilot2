"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyAssaSkillsForLevel } from "../_actions/applyAssaSkillsForLevel";

/**
 * Per-level empty-state choice — Skills equivalent of Chunk 4's
 * `AssaDefaultPrompt`. Two buttons:
 *   - "Use ASSA defaults for this level" calls
 *     `applyAssaSkillsForLevel({ levelId })` and `revalidatePath` brings
 *     the section back populated.
 *   - "Start from scratch" navigates to `?mode=scratch` (single boolean
 *     suppressing all prompts at once — see the page comment).
 *
 * Duplicated from Chunk 4 rather than parameterised: the copy differs
 * ("for this level"), the action it calls differs, and parameterising
 * across two callers is more bookkeeping than copying a 30-line
 * component.
 */
export function AssaSkillsPrompt({
  schoolSlug,
  levelId,
  levelName,
}: {
  schoolSlug: string;
  levelId: string;
  levelName: string;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function chooseAssa() {
    startTransition(async () => {
      const result = await applyAssaSkillsForLevel({ levelId });
      if (!result.ok) {
        // Surface the friendly form-level message via an alert. Same
        // shape as Chunk 4's prompt — concurrent double-click is the
        // rare failure mode and an inline error surface would be over-
        // engineering for a four-button card.
        window.alert(result.error.message);
      }
    });
  }

  function chooseScratch() {
    startTransition(() => {
      router.push(`/s/${schoolSlug}/onboarding/skills?mode=scratch`);
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-950">
      <p className="text-sm text-zinc-700 dark:text-zinc-200">
        Get a head start on {levelName} with the ASSA-aligned default
        skills, or build your own.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={chooseScratch}
          disabled={pending}
          className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm dark:border-zinc-700"
        >
          Start from scratch
        </button>
        <button
          type="button"
          onClick={chooseAssa}
          disabled={pending}
          className="rounded-full bg-foreground px-4 py-1.5 text-sm text-background disabled:opacity-50"
        >
          {pending ? "Applying…" : "Use ASSA defaults for this level"}
        </button>
      </div>
    </div>
  );
}
