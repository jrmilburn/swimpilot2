"use server";

import { redirect } from "next/navigation";
import { markImportComplete } from "./markImportComplete";
import { parseCsvAction, type ParseCsvResult } from "./parseCsv";
import { dryRunImportAction, type DryRunResult } from "./dryRunImport";
import { commitImportAction } from "./commitImport";
import { rollbackImportAction } from "./rollbackImport";
import type {
  ImportMapping,
  ImportTargetField,
} from "@/domain/types";
import type { ResolutionMap } from "@/repositories/importRepository";

// The Import bridge is doing more work than the other onboarding bridges
// because the page is interactive (parse → map → dry-run → commit →
// rollback) before the wizard-advance step. Each interactive intent
// returns a state slice; only the terminal `save` / `skip` intents
// redirect.

export type ImportPhase =
  | "idle"
  | "parsed"
  | "validated"
  | "committed"
  | "rolled_back";

export type ImportFormState = {
  message: string | null;
  fieldErrors: Partial<Record<"_form", string>>;
  phase: ImportPhase;
  // Shape pinned to what the page renders. Each pane reads what's
  // populated for the current phase.
  csv: ParseCsvResult | null;
  mapping: ImportMapping | null;
  resolutions: ResolutionMap;
  report: DryRunResult | null;
  commit: { batchId: string; familyCount: number; studentCount: number; enrolmentCount: number } | null;
};

export const initialImportFormState: ImportFormState = {
  message: null,
  fieldErrors: {},
  phase: "idle",
  csv: null,
  mapping: null,
  resolutions: {},
  report: null,
  commit: null,
};

function readJson<T>(formData: FormData, key: string, fallback: T): T {
  const raw = formData.get(key);
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function errorState(prev: ImportFormState, message: string): ImportFormState {
  return {
    ...prev,
    message,
    fieldErrors: { _form: message },
  };
}

export async function saveImportForm(
  schoolSlug: string,
  prev: ImportFormState,
  formData: FormData,
): Promise<ImportFormState> {
  const intent = formData.get("intent");

  if (intent === "parse-csv") {
    const csvText = (formData.get("csvText") as string | null) ?? "";
    const result = await parseCsvAction({ csvText });
    if (!result.ok) return errorState(prev, result.error.message);
    return {
      ...prev,
      message: null,
      fieldErrors: {},
      phase: "parsed",
      csv: result.data,
      // Reset downstream state: a new file invalidates everything.
      mapping: null,
      resolutions: {},
      report: null,
      commit: null,
    };
  }

  if (intent === "dry-run") {
    const csv = prev.csv;
    if (!csv) return errorState(prev, "Upload a CSV first.");
    const mapping = readJson<ImportMapping>(
      formData,
      "mapping",
      prev.mapping ?? autoMap(csv.headers),
    );
    const resolutions = readJson<ResolutionMap>(
      formData,
      "resolutions",
      prev.resolutions,
    );
    const result = await dryRunImportAction({
      headers: csv.headers,
      rows: csv.rows,
      mapping,
      resolutions,
    });
    if (!result.ok) return errorState(prev, result.error.message);
    return {
      ...prev,
      message: null,
      fieldErrors: {},
      phase: "validated",
      mapping,
      resolutions,
      report: result.data,
      commit: null,
    };
  }

  if (intent === "commit") {
    const csv = prev.csv;
    if (!csv) return errorState(prev, "Upload a CSV first.");
    const mapping = readJson<ImportMapping>(
      formData,
      "mapping",
      prev.mapping ?? autoMap(csv.headers),
    );
    const resolutions = readJson<ResolutionMap>(
      formData,
      "resolutions",
      prev.resolutions,
    );
    const result = await commitImportAction({
      headers: csv.headers,
      rows: csv.rows,
      mapping,
      resolutions,
    });
    if (!result.ok) return errorState(prev, result.error.message);
    const data = result.data;
    if (!data.ok) {
      return {
        ...prev,
        message:
          "Validation found errors at commit time — review the report and fix the resolutions.",
        fieldErrors: {},
        phase: "validated",
        mapping,
        resolutions,
        report: data.report,
        commit: null,
      };
    }
    return {
      ...prev,
      message: null,
      fieldErrors: {},
      phase: "committed",
      mapping,
      resolutions,
      // Re-run dry-run report from the prior call is stale — clear it
      // so the UI shows the success summary instead.
      report: null,
      commit: data.result,
    };
  }

  if (intent === "rollback") {
    const batchId = (formData.get("batchId") as string | null) ?? prev.commit?.batchId ?? "";
    if (!batchId) return errorState(prev, "No batch to roll back.");
    const result = await rollbackImportAction({ batchId });
    if (!result.ok) return errorState(prev, result.error.message);
    return {
      ...prev,
      message: null,
      fieldErrors: {},
      phase: "rolled_back",
      commit: null,
    };
  }

  // Terminal step-advance intents — these redirect.
  const skip = intent === "skip";
  const result = await markImportComplete({ skip });
  if (!result.ok) {
    if (result.error.code === "VALIDATION") {
      const msg = result.error.message;
      return {
        ...prev,
        message: msg,
        fieldErrors: result.error.fieldErrors
          ? (result.error.fieldErrors as ImportFormState["fieldErrors"])
          : { _form: msg },
      };
    }
    return errorState(prev, result.error.message);
  }
  redirect(`/s/${schoolSlug}`);
}

// Best-effort auto-mapping from common header spellings. Keeps the
// initial dry-run from being noise when the operator's CSV uses the
// obvious column names. Anything ambiguous stays as "ignore" so the
// operator has to confirm.
const AUTO_MAP_TABLE: Record<string, ImportTargetField> = {
  email: "family.primary_contact_email",
  parent_email: "family.primary_contact_email",
  family_email: "family.primary_contact_email",
  contact_email: "family.primary_contact_email",
  parent_name: "family.primary_contact_name",
  family_name: "family.primary_contact_name",
  contact_name: "family.primary_contact_name",
  parent: "family.primary_contact_name",
  guardian: "family.primary_contact_name",
  phone: "family.primary_contact_phone",
  parent_phone: "family.primary_contact_phone",
  contact_phone: "family.primary_contact_phone",
  mobile: "family.primary_contact_phone",
  first_name: "student.first_name",
  firstname: "student.first_name",
  given_name: "student.first_name",
  last_name: "student.last_name",
  lastname: "student.last_name",
  surname: "student.last_name",
  family_surname: "student.last_name",
  date_of_birth: "student.date_of_birth",
  dob: "student.date_of_birth",
  birthday: "student.date_of_birth",
  level: "enrolment.level_name",
  level_name: "enrolment.level_name",
  class_level: "enrolment.level_name",
  class: "enrolment.level_name",
  day: "enrolment.day",
  day_of_week: "enrolment.day",
  weekday: "enrolment.day",
  time: "enrolment.time",
  start_time: "enrolment.time",
  class_time: "enrolment.time",
  frequency: "enrolment.frequency",
  freq: "enrolment.frequency",
};

function autoMap(headers: string[]): ImportMapping {
  const out: ImportMapping = {};
  for (const h of headers) {
    const k = h.trim().toLowerCase().replace(/\s+/g, "_");
    out[h] = AUTO_MAP_TABLE[k] ?? "ignore";
  }
  return out;
}
