"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { tenantAction } from "@/lib/auth/tenantAction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import * as classRepository from "@/repositories/classRepository";
import * as classLevelRepository from "@/repositories/classLevelRepository";
import * as locationRepository from "@/repositories/locationRepository";
import {
  UpdateClassSchema,
  capacityExceedsRatioMessage,
} from "./classFields";
import type { WeekDay } from "@/domain/enums";

const Input = z.object({
  id: z.uuid("Invalid class id"),
  patch: UpdateClassSchema,
});

/**
 * Update fields on a single class row. The patch is `Partial<...>`:
 * the form sends the full row but the action only forwards changed
 * keys. `levelId` is intentionally not part of the surface — see
 * `classFields.ts`.
 *
 * Capacity-vs-ratio is re-validated using the row's existing level
 * (level changes are not allowed). Cross-tenant `locationId` defence
 * mirrors `addClass` — a `NotFoundError` surfaces a typed error
 * rather than letting the trigger raise a `check_violation`.
 */
export const updateClass = tenantAction(async ({ tx }, input: unknown) => {
  const parsed = Input.safeParse(input);
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
  const { id, patch } = parsed.data;

  const existing = await classRepository.getById(tx, id);
  if (!existing) throw new NotFoundError("Class not found");

  if (patch.locationId && patch.locationId !== existing.locationId) {
    const location = await locationRepository.getById(tx, patch.locationId);
    if (!location) throw new NotFoundError("Location not found");
  }

  if (patch.capacity !== undefined) {
    const level = await classLevelRepository.getById(tx, existing.levelId);
    if (!level) throw new NotFoundError("Level not found");
    if (patch.capacity > level.ratio) {
      throw new ValidationError(
        capacityExceedsRatioMessage(patch.capacity, level.ratio),
        {
          capacity: capacityExceedsRatioMessage(patch.capacity, level.ratio),
        },
      );
    }
  }

  const updated = await classRepository.update(tx, id, {
    ...(patch.locationId !== undefined ? { locationId: patch.locationId } : {}),
    ...(patch.dayOfWeek !== undefined
      ? { dayOfWeek: patch.dayOfWeek as WeekDay }
      : {}),
    ...(patch.startTime !== undefined ? { startTime: patch.startTime } : {}),
    ...(patch.durationMinutes !== undefined
      ? { durationMinutes: patch.durationMinutes }
      : {}),
    ...(patch.capacity !== undefined ? { capacity: patch.capacity } : {}),
  });

  revalidatePath("/s/[schoolSlug]/onboarding/classes", "page");
  revalidatePath("/s/[schoolSlug]/onboarding/teachers", "page");
  return updated;
});
