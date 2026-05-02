"use server";

import { revalidatePath } from "next/cache";
import { tenantAction } from "@/lib/auth/tenantAction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import * as classLevelRepository from "@/repositories/classLevelRepository";
import * as locationRepository from "@/repositories/locationRepository";
import * as classRepository from "@/repositories/classRepository";
import {
  CreateClassSchema,
  capacityExceedsRatioMessage,
} from "./classFields";
import type { WeekDay } from "@/domain/enums";

/**
 * Create a single class row under one (level, location). The
 * `classes_consistency` trigger enforces:
 *   - school_id matches level.school_id and location.school_id,
 *   - capacity ≤ level.ratio,
 *   - teacher_id, when set, has an active membership,
 *   - pending_teacher_invitation_id, when set, points at a pending row.
 *
 * The action repeats the level / location ownership pre-check so a
 * cross-tenant id surfaces as `NotFoundError` (404 in the dashboard,
 * "Level not found" / "Location not found" in the wizard) rather than
 * letting a Postgres `check_violation` leak through. RLS already hides
 * the foreign rows, so the pre-check never sees them.
 *
 * Capacity is validated in app code so the operator gets the typed
 * `fieldErrors.capacity` keyed message before the row hits the trigger.
 * The wording in `capacityExceedsRatioMessage` mirrors the trigger's
 * `RAISE EXCEPTION` text exactly — defence in depth, identical UX.
 */
export const addClass = tenantAction(async ({ tx }, input: unknown) => {
  const parsed = CreateClassSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path[issue.path.length - 1];
      if (typeof path === "string" && !fieldErrors[path]) {
        fieldErrors[path] = issue.message;
      }
    }
    const first = parsed.error.issues[0];
    throw new ValidationError(first?.message ?? "Invalid class", fieldErrors);
  }
  const data = parsed.data;

  const [level, location] = await Promise.all([
    classLevelRepository.getById(tx, data.levelId),
    locationRepository.getById(tx, data.locationId),
  ]);
  if (!level) throw new NotFoundError("Level not found");
  if (!location) throw new NotFoundError("Location not found");

  if (data.capacity > level.ratio) {
    throw new ValidationError(
      capacityExceedsRatioMessage(data.capacity, level.ratio),
      {
        capacity: capacityExceedsRatioMessage(data.capacity, level.ratio),
      },
    );
  }

  const created = await classRepository.create(tx, {
    levelId: data.levelId,
    locationId: data.locationId,
    dayOfWeek: data.dayOfWeek as WeekDay,
    startTime: data.startTime,
    durationMinutes: data.durationMinutes,
    capacity: data.capacity,
  });

  revalidatePath("/s/[schoolSlug]/onboarding/classes", "page");
  revalidatePath("/s/[schoolSlug]/onboarding/teachers", "page");
  return created;
});
