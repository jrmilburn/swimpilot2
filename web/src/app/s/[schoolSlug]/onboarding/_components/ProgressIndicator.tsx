import Link from "next/link";
import { OnboardingStepStatus } from "@/domain/enums";
import {
  WIZARD_STEPS,
  WIZARD_STEP_LABELS,
  type WizardStep,
} from "@/domain/onboarding";
import type { StepStatusMap } from "@/domain/onboarding";

type Props = {
  schoolSlug: string;
  currentStep: WizardStep;
  stepStatuses: StepStatusMap;
};

// Server-rendered step indicator. Completed steps are clickable links
// (the user may want to revisit them); the current step is highlighted
// but not a link (we're already there); future / not-yet-reached steps
// are disabled. No client JS — Sprint 5+ form pages will keep this
// shape.
export function ProgressIndicator({
  schoolSlug,
  currentStep,
  stepStatuses,
}: Props) {
  const currentIndex = WIZARD_STEPS.indexOf(currentStep);

  return (
    <nav aria-label="Onboarding progress">
      <ol className="flex items-center gap-2 text-sm">
        {WIZARD_STEPS.map((step, idx) => {
          const status = stepStatuses[step] ?? OnboardingStepStatus.NotStarted;
          const isCurrent = step === currentStep;
          const isCompleted = status === OnboardingStepStatus.Completed;
          // A step is reachable if it's the current one, or it's been
          // completed (revisit). Skipped steps are reachable too — the user
          // explicitly chose to skip and may want to come back.
          const isReachable =
            isCurrent ||
            isCompleted ||
            status === OnboardingStepStatus.Skipped ||
            (currentIndex >= 0 && idx < currentIndex);

          const label = WIZARD_STEP_LABELS[step];
          const stepNumber = idx + 1;
          const baseClass =
            "flex items-center gap-2 rounded-md px-3 py-1.5 text-xs uppercase tracking-wide";
          const stateClass = isCurrent
            ? "bg-foreground text-background"
            : isCompleted
              ? "border border-zinc-300 text-zinc-900 dark:border-zinc-700 dark:text-zinc-100"
              : "border border-dashed border-zinc-300 text-zinc-400 dark:border-zinc-700 dark:text-zinc-600";

          const content = (
            <span className={`${baseClass} ${stateClass}`}>
              <span aria-hidden>{stepNumber}.</span>
              <span>{label}</span>
            </span>
          );

          return (
            <li key={step} aria-current={isCurrent ? "step" : undefined}>
              {isReachable && !isCurrent ? (
                <Link href={`/s/${schoolSlug}/onboarding/${step}`}>
                  {content}
                </Link>
              ) : (
                content
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
