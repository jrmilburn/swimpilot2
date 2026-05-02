import { z } from "zod";
import { WeekDay } from "@/domain/enums";

// Shared zod field schemas for the per-row class actions. Mirrors the
// shape of `levelFields.ts` / `skillFields.ts`: the action layer parses
// with these and feeds zod issues into a `fieldErrors` map.
//
// The capacity-vs-level.ratio gate is **not** enforced here — it depends
// on the level row, which the action reads inside the tenant
// transaction. The trigger `classes_consistency` is the second line of
// defence and raises with the same error wording the action surfaces:
// `class.capacity (X) cannot exceed level.ratio (Y)`.

// `HH:MM` only — seconds are not surfaced in the UI. The repository's
// `stringToTime` accepts `HH:MM[:SS]`; we keep the action's surface
// narrower to keep the form simple. 24-hour clock.
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const StartTimeField = z
  .string({ message: "Start time is required" })
  .regex(TIME_RE, "Start time must be HH:MM (24-hour)");

// Multiples of 5 between 15 and 120 inclusive. The select renders these
// 22 options; the schema enforces the same set so a hand-crafted
// submission can't slip past.
export const DurationMinutesField = z
  .number({ message: "Duration is required" })
  .int("Duration must be a whole number of minutes")
  .min(15, "Duration must be at least 15 minutes")
  .max(120, "Duration cannot exceed 120 minutes")
  .refine((n) => n % 5 === 0, "Duration must be in 5-minute steps");

export const CapacityField = z
  .number({ message: "Capacity is required" })
  .int("Capacity must be a whole number")
  .min(1, "Capacity must be at least 1");

export const DayOfWeekField = z.enum(
  Object.values(WeekDay) as [string, ...string[]],
  { message: "Day of week is required" },
);

export const CreateClassSchema = z.object({
  levelId: z.uuid("Invalid level id"),
  locationId: z.uuid("Invalid location id"),
  dayOfWeek: DayOfWeekField,
  startTime: StartTimeField,
  durationMinutes: DurationMinutesField,
  capacity: CapacityField,
});

// `levelId` is intentionally absent from the update schema — a class
// stays in the level it was created under. To "move" between levels,
// archive and recreate. The repository's `update` doesn't expose
// `levelId` either, defending in depth (mirrors the skills convention).
export const UpdateClassSchema = z.object({
  locationId: z.uuid("Invalid location id").optional(),
  dayOfWeek: DayOfWeekField.optional(),
  startTime: StartTimeField.optional(),
  durationMinutes: DurationMinutesField.optional(),
  capacity: CapacityField.optional(),
});

export type CreateClassFormInput = z.infer<typeof CreateClassSchema>;
export type UpdateClassFormInput = z.infer<typeof UpdateClassSchema>;

// Helper: validate capacity against the level's ratio. The wording
// matches the `classes_consistency` trigger's `RAISE EXCEPTION` text so
// the action layer error surface is identical whether the gate fires in
// app code or in Postgres.
export function capacityExceedsRatioMessage(
  capacity: number,
  ratio: number,
): string {
  return `class.capacity (${capacity}) cannot exceed level.ratio (${ratio})`;
}
