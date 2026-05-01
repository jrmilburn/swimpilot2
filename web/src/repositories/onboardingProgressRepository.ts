import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/db/client";
import type { TenantTx } from "../lib/db/withTenant";
import { NotFoundError } from "../lib/errors";
import {
  OnboardingStep,
  OnboardingStepStatus,
} from "../domain/enums";
import type { StepStatusMap } from "../domain/onboarding";
import type { OnboardingProgress } from "../domain/types";

export type DbClient = TenantTx | typeof prisma;

type Row = Prisma.OnboardingProgressGetPayload<Record<string, never>>;

const STEP_VALUES: ReadonlySet<string> = new Set(Object.values(OnboardingStep));
const STATUS_VALUES: ReadonlySet<string> = new Set(
  Object.values(OnboardingStepStatus),
);

// Parse the JSONB column to a typed map. Unknown keys are dropped silently;
// invalid values fall back to `not_started` so a hand-edited row never
// crashes the redirect path. Repository writes always go through
// `serialiseStepStatuses` below so the stored shape stays clean — the
// permissive parser only matters for forward-compat with future enum
// additions and for hand-edited rows in dev.
function parseStepStatuses(value: Prisma.JsonValue): StepStatusMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: StepStatusMap = {};
  for (const [k, v] of Object.entries(value)) {
    if (!STEP_VALUES.has(k)) continue;
    if (typeof v !== "string" || !STATUS_VALUES.has(v)) {
      out[k as OnboardingStep] = OnboardingStepStatus.NotStarted;
      continue;
    }
    out[k as OnboardingStep] = v as OnboardingStepStatus;
  }
  return out;
}

function serialiseStepStatuses(map: StepStatusMap): Prisma.InputJsonValue {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (!v) continue;
    out[k] = v;
  }
  return out;
}

function toOnboardingProgress(row: Row): OnboardingProgress {
  return {
    schoolId: row.schoolId,
    currentStep: row.currentStep as OnboardingStep,
    stepStatuses: parseStepStatuses(row.stepStatuses),
    lastActivityAt: row.lastActivityAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Read the onboarding row for the current tenant (or a specific school
 * within it — passing `schoolId` is a convenience; RLS enforces that the
 * row must already belong to the open tenant context).
 *
 * Returns `null` if the row doesn't exist. The AFTER INSERT trigger on
 * `schools` materialises this row at school-creation time, so a missing
 * row indicates a real bug (trigger didn't fire, manual DELETE, etc.) —
 * the wizard layout opts to throw rather than auto-create. See the layout
 * for that handling.
 */
export async function getBySchool(
  db: DbClient,
  schoolId: string,
): Promise<OnboardingProgress | null> {
  const row = await db.onboardingProgress.findUnique({
    where: { schoolId },
  });
  return row ? toOnboardingProgress(row) : null;
}

/**
 * Flip one step's status, optionally also advancing `current_step` to a
 * new value (typically the next step in the wizard order). Bumps
 * `last_activity_at` so abandoned-onboarding queries don't have to dig
 * through audit fields.
 *
 * Throws `NotFoundError` if the row doesn't exist — see `getBySchool` for
 * why we don't auto-create.
 */
export async function markStepStatus(
  db: DbClient,
  args: {
    schoolId: string;
    step: OnboardingStep;
    status: OnboardingStepStatus;
    nextStep?: OnboardingStep;
  },
): Promise<OnboardingProgress> {
  const existing = await db.onboardingProgress.findUnique({
    where: { schoolId: args.schoolId },
  });
  if (!existing) {
    throw new NotFoundError(
      `onboarding_progress for school ${args.schoolId} not found`,
    );
  }

  const merged: StepStatusMap = {
    ...parseStepStatuses(existing.stepStatuses),
    [args.step]: args.status,
  };

  const data: Prisma.OnboardingProgressUpdateInput = {
    stepStatuses: serialiseStepStatuses(merged),
    lastActivityAt: new Date(),
  };
  if (args.nextStep) {
    data.currentStep = args.nextStep;
  }

  const row = await db.onboardingProgress.update({
    where: { schoolId: args.schoolId },
    data,
  });
  return toOnboardingProgress(row);
}

/**
 * Mark the wizard finished. Sets `completed_at` and points `current_step`
 * at `done`. Idempotent — safe to call on an already-complete row.
 */
export async function complete(
  db: DbClient,
  schoolId: string,
): Promise<OnboardingProgress> {
  const now = new Date();
  const row = await db.onboardingProgress.update({
    where: { schoolId },
    data: {
      completedAt: now,
      currentStep: OnboardingStep.Done,
      lastActivityAt: now,
    },
  });
  return toOnboardingProgress(row);
}
