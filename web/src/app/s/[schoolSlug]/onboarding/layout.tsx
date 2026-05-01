import Link from "next/link";
import { requireTenant } from "@/lib/auth/requireTenant";
import { withTenant } from "@/lib/db/withTenant";
import { isWizardStep } from "@/domain/onboarding";
import * as onboardingProgressRepository from "@/repositories/onboardingProgressRepository";
import { ProgressIndicator } from "./_components/ProgressIndicator";

// TODO(Chunk 6+): replace with the real "book a migration call" URL once
// Studio Parallel publishes one. Chunk 1 keeps the link static — the
// chunk explicitly defers wiring it up.
const HELP_URL = "https://studioparallel.com.au/contact";

export default async function OnboardingLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ schoolSlug: string }>;
}) {
  const { schoolSlug } = await params;
  const { schoolId, userId } = await requireTenant(schoolSlug);

  // Read inside withTenant so RLS scopes the lookup. The AFTER INSERT
  // trigger on `schools` materialises the onboarding row at school
  // creation; a missing row indicates a real bug (trigger didn't fire,
  // manual DELETE) so we throw rather than auto-create. Auto-creating
  // would silently paper over the bug and cost us a Sprint 5 debugging
  // session. Documented decision — see the Chunk 1 handoff.
  const progress = await withTenant({ schoolId, userId }, (tx) =>
    onboardingProgressRepository.getBySchool(tx, schoolId),
  );
  if (!progress) {
    throw new Error(
      `onboarding_progress row missing for school ${schoolId}; ` +
        "the AFTER INSERT trigger should have created it.",
    );
  }

  // The current step value comes from the DB enum (which carries every
  // Sprint 4–9 step) but the wizard chrome only renders the four visible
  // ones. If the DB value is outside that subset (e.g. `done`, or a
  // future Sprint 5+ step landing here before its chunk ships), fall
  // back to highlighting the first step — better than crashing.
  const currentWizardStep = isWizardStep(progress.currentStep)
    ? progress.currentStep
    : "profile";

  return (
    <div className="flex min-h-full flex-col bg-zinc-50 font-sans dark:bg-black">
      <header className="flex flex-col gap-4 border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold tracking-tight">
            Set up your school
          </h1>
          <div className="flex items-center gap-4 text-sm">
            <a
              href={HELP_URL}
              className="text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              target="_blank"
              rel="noopener noreferrer"
            >
              Help / book a migration call
            </a>
            <Link
              href={`/s/${schoolSlug}`}
              className="rounded-full border border-zinc-300 px-3 py-1.5 text-zinc-700 dark:border-zinc-700 dark:text-zinc-200"
            >
              Save and exit
            </Link>
          </div>
        </div>
        <ProgressIndicator
          schoolSlug={schoolSlug}
          currentStep={currentWizardStep}
          stepStatuses={progress.stepStatuses}
        />
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
