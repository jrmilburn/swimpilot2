"use server";

import { z } from "zod";
import { tenantAction } from "@/lib/auth/tenantAction";
import { ValidationError } from "@/lib/errors";
import * as importRepository from "@/repositories/importRepository";
import type { ValidationReport } from "@/repositories/importRepository";

const ResolutionSchema = z.object({
  kind: z.enum([
    "merge",
    "use_suggested_level",
    "exclude_enrolment",
    "exclude_row",
  ]),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const TargetField = z.enum([
  "family.primary_contact_name",
  "family.primary_contact_email",
  "family.primary_contact_phone",
  "student.first_name",
  "student.last_name",
  "student.date_of_birth",
  "enrolment.level_name",
  "enrolment.day",
  "enrolment.time",
  "enrolment.frequency",
]);

const Input = z.object({
  rows: z.array(z.array(z.string())),
  headers: z.array(z.string()),
  mapping: z.record(z.string(), z.union([TargetField, z.literal("ignore")])),
  resolutions: z.record(z.string(), ResolutionSchema).default({}),
});

export type DryRunResult = ValidationReport;

export const dryRunImportAction = tenantAction(
  async ({ tx }, input: unknown): Promise<DryRunResult> => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? "Invalid input",
      );
    }

    // Coerce the JSON-string keys of `resolutions` (1-indexed row numbers)
    // back to numbers, since FormData/JSON can only carry string keys.
    const resolutions: importRepository.ResolutionMap = {};
    for (const [k, v] of Object.entries(parsed.data.resolutions)) {
      const n = Number.parseInt(k, 10);
      if (Number.isFinite(n) && n > 0) {
        resolutions[n] = v as importRepository.Resolution;
      }
    }

    return importRepository.dryRunImport(tx, {
      rows: parsed.data.rows,
      headers: parsed.data.headers,
      mapping: parsed.data.mapping,
      resolutions,
    });
  },
);
