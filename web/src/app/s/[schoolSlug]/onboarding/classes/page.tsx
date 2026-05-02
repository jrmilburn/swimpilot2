import Link from "next/link";
import { requireTenant } from "@/lib/auth/requireTenant";
import { withTenant } from "@/lib/db/withTenant";
import * as classLevelRepository from "@/repositories/classLevelRepository";
import * as classRepository from "@/repositories/classRepository";
import * as locationRepository from "@/repositories/locationRepository";
import type { Class } from "@/domain/types";
import { ClassesAccordion } from "./_components/ClassesAccordion";
import { ContinueControls } from "./_components/ContinueControls";

/**
 * Sprint 5 / Chunk 1 — the real Classes step body.
 *
 * Three rendering branches:
 *   1. Zero locations: the operator must add at least one location
 *      before defining classes (the row needs a location_id). Render
 *      a "blocked by locations" hint that links back; Skip remains
 *      available via the parent `ContinueControls`.
 *   2. Zero levels: same shape as (1), but pointing back at Levels.
 *   3. Levels and locations both present: render the accordion. The
 *      Continue button is disabled until ≥ 1 class exists; Skip is
 *      always available.
 *
 * Both the action layer and the page enforce the "≥ 1 class on save"
 * gate. The page disables Continue locally so the operator gets a
 * cheap visual signal without a round-trip; the action does the
 * authoritative count check inside the same `withTenant` tx so a
 * stale page render can't bypass the gate.
 */
export default async function ClassesStepPage({
  params,
}: {
  params: Promise<{ schoolSlug: string }>;
}) {
  const { schoolSlug } = await params;
  const { schoolId, userId } = await requireTenant(schoolSlug);

  const { levels, locations, classesByLevel } = await withTenant(
    { schoolId, userId },
    async (tx) => {
      const [levels, locations] = await Promise.all([
        classLevelRepository.listBySchool(tx),
        locationRepository.listBySchool(tx),
      ]);
      const classesByLevel: Record<string, Class[]> = {};
      for (const level of levels) {
        classesByLevel[level.id] = await classRepository.listByLevel(
          tx,
          level.id,
        );
      }
      return { levels, locations, classesByLevel };
    },
  );

  const totalClasses = Object.values(classesByLevel).reduce(
    (sum, list) => sum + list.length,
    0,
  );

  if (locations.length === 0) {
    return (
      <BlockedByPrereq
        title="Add a location first"
        message="Classes belong to a location (a pool or venue). Add at least one location before setting up your class schedule."
        backHref={`/s/${schoolSlug}/onboarding/locations`}
        backLabel="Back to Locations"
        schoolSlug={schoolSlug}
      />
    );
  }
  if (levels.length === 0) {
    return (
      <BlockedByPrereq
        title="Add a level first"
        message="Classes attach to a level (the level's ratio caps the class capacity). Add at least one level before setting up your class schedule."
        backHref={`/s/${schoolSlug}/onboarding/levels`}
        backLabel="Back to Levels"
        schoolSlug={schoolSlug}
      />
    );
  }

  return (
    <section className="flex flex-1 flex-col items-center px-6 py-10">
      <div className="flex w-full max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h2 className="text-xl font-semibold tracking-tight">
            Set up your classes
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Classes are the recurring time slots families enrol into.
            Set them up per level — capacity is capped by the level&apos;s
            ratio, and multi-lane pools can run concurrent classes at
            the same time. You can add more classes from the dashboard
            anytime later.
          </p>
        </header>

        <ClassesAccordion
          levels={levels}
          classesByLevel={classesByLevel}
          locations={locations}
        />

        <ContinueControls
          schoolSlug={schoolSlug}
          disableSave={totalClasses === 0}
        />
      </div>
    </section>
  );
}

function BlockedByPrereq({
  title,
  message,
  backHref,
  backLabel,
  schoolSlug,
}: {
  title: string;
  message: string;
  backHref: string;
  backLabel: string;
  schoolSlug: string;
}) {
  return (
    <section className="flex flex-1 flex-col items-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h2 className="text-xl font-semibold tracking-tight">
            Set up your classes
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{message}</p>
        </header>
        <div className="rounded-md border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950">
          <p className="font-medium">{title}</p>
          <Link
            href={backHref}
            className="mt-3 inline-block rounded-full border border-zinc-300 px-3 py-1.5 dark:border-zinc-700"
          >
            {backLabel}
          </Link>
        </div>
        <ContinueControls schoolSlug={schoolSlug} disableSave={true} />
      </div>
    </section>
  );
}
