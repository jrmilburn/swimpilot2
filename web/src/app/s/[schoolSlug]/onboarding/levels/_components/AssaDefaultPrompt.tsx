"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { ASSA_LEVEL_TEMPLATE } from "@/domain/assaLevelTemplate";
import { applyAssaDefaults } from "../_actions/applyAssaDefaults";

/**
 * Empty-state choice. Two buttons:
 *   - "Use the ASSA-aligned default" calls `applyAssaDefaults` and
 *     `revalidatePath` brings the page back populated.
 *   - "Start from scratch" navigates to `?mode=scratch`. The page reads
 *     that query param to skip rendering the prompt and open the inline
 *     editor instead. Stateless and reversible (the operator can drop
 *     the param by navigating back).
 *
 * Once any level exists, this component is no longer rendered — the
 * page loads the standard list view directly.
 */
export function AssaDefaultPrompt({ schoolSlug }: { schoolSlug: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function chooseAssa() {
    startTransition(async () => {
      const result = await applyAssaDefaults();
      if (!result.ok) {
        // Surface the friendly form-level message via an alert. The
        // empty state is rare enough — and the failure mode is rarer
        // still (concurrent double-click) — that an inline error
        // surface would be over-engineering.
        window.alert(result.error.message);
      }
    });
  }

  function chooseScratch() {
    startTransition(() => {
      router.push(`/s/${schoolSlug}/onboarding/levels?mode=scratch`);
    });
  }

  return (
    <section className="flex flex-col gap-4 rounded-md border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
      <header className="flex flex-col gap-1">
        <h3 className="text-base font-semibold tracking-tight">
          Get started with a standard framework, or build your own
        </h3>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Most swim schools start with the four ASSA-aligned levels and
          adjust from there. You can rename, reorder, or remove any of
          them later.
        </p>
      </header>

      <ul className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
        {ASSA_LEVEL_TEMPLATE.map((entry) => (
          <li key={entry.name}>
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              {entry.name}
            </span>
            {" — ratio 1:"}
            {entry.ratio}
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={chooseScratch}
          disabled={pending}
          className="rounded-full border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
        >
          Start from scratch
        </button>
        <button
          type="button"
          onClick={chooseAssa}
          disabled={pending}
          className="rounded-full bg-foreground px-4 py-2 text-sm text-background disabled:opacity-50"
        >
          {pending ? "Applying…" : "Use the ASSA-aligned default"}
        </button>
      </div>
    </section>
  );
}
