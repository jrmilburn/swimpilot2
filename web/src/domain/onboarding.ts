import { OnboardingStep, type OnboardingStepStatus } from "./enums";

// Editorial wizard order — what users walk through. The DB enum
// (`onboarding_step`) carries the same values but Postgres orders them
// alphabetically; the wizard's progression is decided here, in TypeScript.
//
// Sprint 5 / Chunk 1 reorders Billing and Channels to the tail of the
// list. They aren't shipped as wizard steps yet — putting them after
// Import keeps `nextStepAfter(Teachers) === Import` and
// `nextStepAfter(Import) === Billing → Channels → Done`. As Sprint 6+
// ships those steps the order can stay; if the editorial order needs
// to change later, this constant is the only place to touch.
export const ONBOARDING_STEP_ORDER = [
  OnboardingStep.Profile,
  OnboardingStep.Locations,
  OnboardingStep.Levels,
  OnboardingStep.Skills,
  OnboardingStep.Classes,
  OnboardingStep.Teachers,
  OnboardingStep.Import,
  OnboardingStep.Billing,
  OnboardingStep.Channels,
] as const;

export type OnboardingStepCode = (typeof ONBOARDING_STEP_ORDER)[number];

// Subset rendered by the wizard chrome. Sprint 5+ chunks will extend this
// — keeping it explicit (rather than slicing ONBOARDING_STEP_ORDER) means
// the visible steps are an editorial decision, not a side-effect of array
// indexing.
//
// Sprint 5 / Chunk 1 extends WIZARD_STEPS to seven entries: the real
// classes editor lands at `/onboarding/classes`, Teachers ships at
// `/onboarding/teachers`, and a final Import stub renders at
// `/onboarding/import` so operators can wrap up the wizard. Billing /
// Channels remain parked at the end of `ONBOARDING_STEP_ORDER` and
// are not visible in the chrome until their chunks ship.
export const WIZARD_STEPS = [
  OnboardingStep.Profile,
  OnboardingStep.Locations,
  OnboardingStep.Levels,
  OnboardingStep.Skills,
  OnboardingStep.Classes,
  OnboardingStep.Teachers,
  OnboardingStep.Import,
] as const satisfies readonly OnboardingStepCode[];

// `WizardStep` names the steps actually rendered by the wizard chrome
// (the type of an item in `WIZARD_STEPS`). `OnboardingStepCode` covers
// all nine non-`done` codes — useful for code that reasons about steps
// that exist in the DB but aren't yet wizard-visible.
export type WizardStep = (typeof WIZARD_STEPS)[number];

export const WIZARD_STEP_LABELS: Record<OnboardingStepCode, string> = {
  [OnboardingStep.Profile]: "Profile",
  [OnboardingStep.Locations]: "Locations",
  [OnboardingStep.Levels]: "Levels",
  [OnboardingStep.Skills]: "Skills",
  [OnboardingStep.Classes]: "Classes",
  [OnboardingStep.Teachers]: "Teachers",
  [OnboardingStep.Billing]: "Billing",
  [OnboardingStep.Channels]: "Channels",
  [OnboardingStep.Import]: "Import",
};

export function isWizardStep(value: string): value is WizardStep {
  return (WIZARD_STEPS as readonly string[]).includes(value);
}

// The next step in the editorial order, or `OnboardingStep.Done` if there
// is none left. Used by the placeholder "Continue" action to advance
// `current_step` after a step is marked completed. Accepts any
// `OnboardingStepCode` (not just `WizardStep`) so Sprint 5+ chunks can
// reuse this without widening the wizard subset prematurely.
export function nextStepAfter(step: OnboardingStepCode): OnboardingStep {
  const idx = ONBOARDING_STEP_ORDER.indexOf(step);
  if (idx < 0 || idx >= ONBOARDING_STEP_ORDER.length - 1) {
    return OnboardingStep.Done;
  }
  return ONBOARDING_STEP_ORDER[idx + 1]!;
}

// Type for the JSONB `step_statuses` column. The DB stores an open object
// — repository code parses keys it knows about and ignores anything else,
// so a future step landing in an older row is forward-compatible.
export type StepStatusMap = Partial<Record<OnboardingStep, OnboardingStepStatus>>;
