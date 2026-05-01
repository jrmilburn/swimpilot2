import { z } from "zod";

// Shared zod field schema for the per-row class-level actions. Mirrors
// `locationFields.ts` from Chunk 3 — the action layer parses with these,
// builds a `fieldErrors` map from zod issues, and `tenantAction` carries
// the typed payload through to the form.
//
// `orderIndex` is intentionally absent from the create / update form
// schemas. The server normalises positions to `0..n-1` (append on add,
// compact on archive, explicit `reorder` for moves) and never trusts a
// client-supplied index.

export const LevelNameField = z
  .string({ message: "Name is required" })
  .trim()
  .min(1, "Name is required")
  .max(100, "Name is too long");

export const LevelDescriptionField = z
  .string()
  .trim()
  .max(1000, "Description is too long")
  .nullable();

export const LevelRatioField = z
  .number({ message: "Ratio must be a whole number" })
  .int("Ratio must be a whole number")
  .min(1, "Ratio must be at least 1")
  .max(20, "Ratio must be 20 or less");

export const LevelProgressionThresholdField = z
  .number({ message: "Threshold must be a whole number" })
  .int("Threshold must be a whole number")
  .min(0, "Threshold must be 0 or more")
  .max(100, "Threshold must be 100 or less");

export const LevelAgeMonthsField = z
  .number({ message: "Age must be a whole number of months" })
  .int("Age must be a whole number of months")
  .min(0, "Age must be zero or more months")
  .max(1200, "Age is too high")
  .nullable();

// Min/max age refinement applied at the object boundary so the
// fieldErrors map can flag the offending pair without forcing the
// caller to wire the comparison themselves.
const ageRangeRefinement = (data: {
  minAgeMonths?: number | null;
  maxAgeMonths?: number | null;
}) => {
  if (
    data.minAgeMonths != null &&
    data.maxAgeMonths != null &&
    data.minAgeMonths > data.maxAgeMonths
  ) {
    return false;
  }
  return true;
};

export const CreateLevelSchema = z
  .object({
    name: LevelNameField,
    description: LevelDescriptionField.optional().default(null),
    ratio: LevelRatioField,
    defaultProgressionThreshold:
      LevelProgressionThresholdField.optional().default(80),
    minAgeMonths: LevelAgeMonthsField.optional().default(null),
    maxAgeMonths: LevelAgeMonthsField.optional().default(null),
  })
  .refine(ageRangeRefinement, {
    message: "Maximum age must be at least the minimum age",
    path: ["maxAgeMonths"],
  });

export const UpdateLevelSchema = z
  .object({
    name: LevelNameField.optional(),
    description: LevelDescriptionField.optional(),
    ratio: LevelRatioField.optional(),
    defaultProgressionThreshold: LevelProgressionThresholdField.optional(),
    minAgeMonths: LevelAgeMonthsField.optional(),
    maxAgeMonths: LevelAgeMonthsField.optional(),
  })
  .refine(ageRangeRefinement, {
    message: "Maximum age must be at least the minimum age",
    path: ["maxAgeMonths"],
  });

export type CreateLevelFormInput = z.infer<typeof CreateLevelSchema>;
export type UpdateLevelFormInput = z.infer<typeof UpdateLevelSchema>;
