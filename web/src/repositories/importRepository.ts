import type { Prisma } from "@prisma/client";
import { distance as levenshteinDistance } from "fastest-levenshtein";
import { prisma } from "../lib/db/client";
import { getSchoolId } from "../lib/db/context";
import type { TenantTx } from "../lib/db/withTenant";
import {
  EnrolmentFrequency,
  EnrolmentStatus,
  StudentStatus,
  WeekDay,
} from "../domain/enums";
import type {
  ImportBatch,
  ImportMapping,
  ImportTargetField,
} from "../domain/types";

export type DbClient = TenantTx | typeof prisma;

// ---------------------------------------------------------------------------
// Public types — the validation report is part of the action-layer contract
// (the page renders it directly), so the shape lives at the repository
// boundary rather than buried in the action.
// ---------------------------------------------------------------------------

export type FindingRule =
  | "duplicate_email"
  | "missing_required"
  | "unknown_level"
  | "capacity_breach";

export type ResolutionKind =
  | "merge"
  | "use_suggested_level"
  | "exclude_enrolment"
  | "exclude_row";

export type Resolution = {
  kind: ResolutionKind;
  // payload shape varies by kind:
  //   merge → { existingFamilyId: string }
  //   use_suggested_level → { levelId: string }
  //   exclude_enrolment / exclude_row → undefined
  payload?: Record<string, unknown>;
};

export type ResolutionMap = Record<number, Resolution>;

export type Finding = {
  row: number; // 1-indexed input row number
  rule: FindingRule;
  severity: "error" | "warning";
  message: string;
  resolution?: Resolution;
};

export type ValidationReport = {
  findings: Finding[];
  preview: {
    familyCount: number;
    studentCount: number;
    enrolmentCount: number;
  };
  blocking: boolean;
};

export type DryRunInput = {
  rows: string[][];
  headers: string[];
  mapping: ImportMapping;
  resolutions: ResolutionMap;
};

export type CommitInput = DryRunInput;

export type CommitResult = {
  batchId: string;
  familyCount: number;
  studentCount: number;
  enrolmentCount: number;
};

// ---------------------------------------------------------------------------
// Mapping helpers — picking out the source column for each target field.
// ---------------------------------------------------------------------------

function findSourceIndex(
  mapping: ImportMapping,
  headers: string[],
  target: ImportTargetField,
): number {
  for (const [header, t] of Object.entries(mapping)) {
    if (t === target) {
      const idx = headers.indexOf(header);
      if (idx >= 0) return idx;
    }
  }
  return -1;
}

function cellAt(row: string[], idx: number): string {
  if (idx < 0) return "";
  return row[idx] ?? "";
}

// ---------------------------------------------------------------------------
// Date parsing. Decision #3 in the chunk handoff: AU DD/MM/YYYY is the
// default, ISO YYYY-MM-DD accepted in parallel, everything else rejected.
// ---------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const AU_DATE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;

export function parseDob(value: string): { date: Date | null; error: string | null } {
  const trimmed = value.trim();
  if (!trimmed) return { date: null, error: null };
  let y: number, m: number, d: number;
  const iso = ISO_DATE.exec(trimmed);
  if (iso) {
    y = Number.parseInt(iso[1]!, 10);
    m = Number.parseInt(iso[2]!, 10);
    d = Number.parseInt(iso[3]!, 10);
  } else {
    const au = AU_DATE.exec(trimmed);
    if (!au) {
      return {
        date: null,
        error: `"${trimmed}" is not a date — use DD/MM/YYYY or YYYY-MM-DD.`,
      };
    }
    d = Number.parseInt(au[1]!, 10);
    m = Number.parseInt(au[2]!, 10);
    y = Number.parseInt(au[3]!, 10);
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    return {
      date: null,
      error: `"${trimmed}" is not a valid date.`,
    };
  }
  // Construct as UTC midnight; the `date` column has no time component.
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return { date: null, error: `"${trimmed}" is not a valid date.` };
  }
  return { date, error: null };
}

// ---------------------------------------------------------------------------
// Day / time / frequency parsing.
// ---------------------------------------------------------------------------

const DAY_LOOKUP: Record<string, WeekDay> = {
  monday: WeekDay.Monday,
  mon: WeekDay.Monday,
  tuesday: WeekDay.Tuesday,
  tue: WeekDay.Tuesday,
  tues: WeekDay.Tuesday,
  wednesday: WeekDay.Wednesday,
  wed: WeekDay.Wednesday,
  thursday: WeekDay.Thursday,
  thu: WeekDay.Thursday,
  thurs: WeekDay.Thursday,
  friday: WeekDay.Friday,
  fri: WeekDay.Friday,
  saturday: WeekDay.Saturday,
  sat: WeekDay.Saturday,
  sunday: WeekDay.Sunday,
  sun: WeekDay.Sunday,
};

function parseDay(value: string): WeekDay | null {
  const k = value.trim().toLowerCase();
  return DAY_LOOKUP[k] ?? null;
}

const TIME_24 = /^(\d{1,2}):(\d{2})$/;
const TIME_12 = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i;

function parseTime(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const m24 = TIME_24.exec(trimmed);
  if (m24) {
    const h = Number.parseInt(m24[1]!, 10);
    const m = Number.parseInt(m24[2]!, 10);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  const m12 = TIME_12.exec(trimmed);
  if (m12) {
    let h = Number.parseInt(m12[1]!, 10);
    const m = Number.parseInt(m12[2]!, 10);
    const ampm = m12[3]!.toLowerCase();
    if (h < 1 || h > 12 || m < 0 || m > 59) return null;
    if (ampm === "pm" && h !== 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  return null;
}

const FREQUENCY_LOOKUP: Record<string, EnrolmentFrequency> = {
  weekly: EnrolmentFrequency.Weekly,
  week: EnrolmentFrequency.Weekly,
  fortnightly: EnrolmentFrequency.FortnightlyA,
  fortnight: EnrolmentFrequency.FortnightlyA,
  fortnightly_a: EnrolmentFrequency.FortnightlyA,
  fortnightly_b: EnrolmentFrequency.FortnightlyB,
  one_off: EnrolmentFrequency.OneOff,
  oneoff: EnrolmentFrequency.OneOff,
  "one-off": EnrolmentFrequency.OneOff,
};

function parseFrequency(value: string): EnrolmentFrequency | null {
  const k = value.trim().toLowerCase().replace(/\s+/g, "_");
  return FREQUENCY_LOOKUP[k] ?? null;
}

// ---------------------------------------------------------------------------
// Row processing. Pure: takes pre-loaded lookup data + the row + mapping
// and returns either a list of findings, or a "to-insert" payload.
//
// `processRow` is the shared core dryRun and commit both call. dryRun
// throws away the inserts; commit applies them.
// ---------------------------------------------------------------------------

type LevelLookup = {
  byNameLower: Map<string, { id: string; ratio: number; name: string }>;
  all: Array<{ id: string; ratio: number; name: string }>;
};

type ClassLookup = {
  // (levelId, day, time) → { classId, capacity }
  byKey: Map<string, { classId: string; capacity: number }>;
  // Existing enrolment counts per classId (active only).
  existingEnrolments: Map<string, number>;
};

type ExistingFamilyLookup = Map<string, string>; // emailLower → familyId

// Both branches carry `findings` so warnings (e.g. capacity_breach,
// merge confirmation) are not silently dropped on otherwise-insertable
// rows. The discriminator is whether the row produced a plan to insert.
export type RowOutcome =
  | { kind: "findings"; findings: Finding[] }
  | {
      kind: "insert";
      findings: Finding[];
      family: {
        primaryContactName: string;
        primaryContactEmail: string;
        primaryContactPhone: string | null;
        // null when the resolution merged this row onto an existing family.
        mergeIntoFamilyId: string | null;
      };
      student: {
        firstName: string;
        lastName: string;
        dateOfBirth: Date | null;
      };
      enrolment: {
        levelId: string;
        day: WeekDay;
        time: string;
        frequency: EnrolmentFrequency;
      } | null;
    };

export type ProcessRowArgs = {
  row: string[];
  rowNumber: number; // 1-indexed for findings
  headers: string[];
  mapping: ImportMapping;
  resolution: Resolution | undefined;
  lookups: {
    levels: LevelLookup;
    classes: ClassLookup;
    existingFamilies: ExistingFamilyLookup;
    // Counts of new-row enrolments per (levelId, day, time) — bumped as rows
    // process so capacity findings reflect the cumulative pressure of the
    // batch, not just one row at a time.
    proposedEnrolments: Map<string, number>;
    // Within-batch email tracker. Keyed by emailLower, value is the row
    // numbers that have used it. Updated by the caller as it iterates.
    seenEmails: Map<string, number[]>;
  };
};

export function processRow(args: ProcessRowArgs): RowOutcome {
  const { row, rowNumber, headers, mapping, resolution, lookups } = args;
  const findings: Finding[] = [];

  const emailIdx = findSourceIndex(mapping, headers, "family.primary_contact_email");
  const nameIdx = findSourceIndex(mapping, headers, "family.primary_contact_name");
  const phoneIdx = findSourceIndex(mapping, headers, "family.primary_contact_phone");
  const firstIdx = findSourceIndex(mapping, headers, "student.first_name");
  const lastIdx = findSourceIndex(mapping, headers, "student.last_name");
  const dobIdx = findSourceIndex(mapping, headers, "student.date_of_birth");
  const levelIdx = findSourceIndex(mapping, headers, "enrolment.level_name");
  const dayIdx = findSourceIndex(mapping, headers, "enrolment.day");
  const timeIdx = findSourceIndex(mapping, headers, "enrolment.time");
  const freqIdx = findSourceIndex(mapping, headers, "enrolment.frequency");

  // Rule 2 — required fields.
  const email = cellAt(row, emailIdx).trim().toLowerCase();
  const firstName = cellAt(row, firstIdx).trim();
  const lastName = cellAt(row, lastIdx).trim();

  if (!email) {
    findings.push({
      row: rowNumber,
      rule: "missing_required",
      severity: "error",
      message:
        emailIdx < 0
          ? "No incoming column mapped to email — every row will be excluded. Map a column or skip the import."
          : "Family email is missing.",
    });
  }
  if (!firstName) {
    findings.push({
      row: rowNumber,
      rule: "missing_required",
      severity: "error",
      message: "Student first name is missing.",
    });
  }
  if (!lastName) {
    findings.push({
      row: rowNumber,
      rule: "missing_required",
      severity: "error",
      message: "Student last name is missing.",
    });
  }

  // Enrolment partial-vs-all-missing check. All four enrolment fields
  // missing → no enrolment, just family + student. Any non-empty subset
  // → must have all four.
  const levelRaw = cellAt(row, levelIdx).trim();
  const dayRaw = cellAt(row, dayIdx).trim();
  const timeRaw = cellAt(row, timeIdx).trim();
  const freqRaw = cellAt(row, freqIdx).trim();
  const enrolmentPresent = [levelRaw, dayRaw, timeRaw, freqRaw].some((s) => s);
  const enrolmentComplete = [levelRaw, dayRaw, timeRaw, freqRaw].every((s) => s);
  if (enrolmentPresent && !enrolmentComplete) {
    findings.push({
      row: rowNumber,
      rule: "missing_required",
      severity: "error",
      message:
        "Enrolment is partly filled — provide all of level, day, time, and frequency, or leave them all blank.",
    });
  }

  // Date-of-birth parse (optional). Decision #4: optional. Surface any
  // parse error as a finding.
  let dob: Date | null = null;
  if (dobIdx >= 0) {
    const raw = cellAt(row, dobIdx);
    const { date, error } = parseDob(raw);
    if (error) {
      findings.push({
        row: rowNumber,
        rule: "missing_required",
        severity: "error",
        message: `Date of birth: ${error}`,
      });
    }
    dob = date;
  }

  // Rule 1 — duplicate email. Within-input duplicates: if any other row
  // shares this email AND a different family contact name, flag.
  if (email) {
    const seenRows = lookups.seenEmails.get(email);
    if (seenRows && seenRows.length > 0) {
      findings.push({
        row: rowNumber,
        rule: "duplicate_email",
        severity: "error",
        message: `Email ${email} also appears on row ${seenRows[0]}.`,
      });
    }
    // Against existing.
    const existingFamilyId = lookups.existingFamilies.get(email);
    if (existingFamilyId) {
      const isResolvedMerge = resolution?.kind === "merge";
      const isResolvedExclude = resolution?.kind === "exclude_row";
      if (!isResolvedMerge && !isResolvedExclude) {
        findings.push({
          row: rowNumber,
          rule: "duplicate_email",
          severity: "error",
          message: `Email ${email} matches an existing family — choose merge or exclude.`,
        });
      } else if (isResolvedMerge) {
        // Resolved: still emit a warning so the operator sees what was
        // merged in the report.
        findings.push({
          row: rowNumber,
          rule: "duplicate_email",
          severity: "warning",
          message: `Merging into existing family for ${email}.`,
          resolution,
        });
      }
    }
  }

  // Rule 3 — unknown level (only if enrolment is present).
  let resolvedLevelId: string | null = null;
  let resolvedClass: { classId: string; capacity: number } | null = null;
  let resolvedDay: WeekDay | null = null;
  let resolvedTime: string | null = null;
  let resolvedFrequency: EnrolmentFrequency | null = null;
  if (enrolmentComplete) {
    const day = parseDay(dayRaw);
    const time = parseTime(timeRaw);
    const frequency = parseFrequency(freqRaw);
    if (!day) {
      findings.push({
        row: rowNumber,
        rule: "missing_required",
        severity: "error",
        message: `"${dayRaw}" is not a recognised day.`,
      });
    }
    if (!time) {
      findings.push({
        row: rowNumber,
        rule: "missing_required",
        severity: "error",
        message: `"${timeRaw}" is not a recognised time — use HH:MM or HH:MM AM/PM.`,
      });
    }
    if (!frequency) {
      findings.push({
        row: rowNumber,
        rule: "missing_required",
        severity: "error",
        message: `"${freqRaw}" is not a recognised frequency.`,
      });
    }
    resolvedDay = day;
    resolvedTime = time;
    resolvedFrequency = frequency;

    const levelKey = levelRaw.toLowerCase();
    const matched = lookups.levels.byNameLower.get(levelKey);
    if (matched) {
      resolvedLevelId = matched.id;
    } else {
      // Levenshtein suggestion.
      let bestSuggestion: { id: string; name: string; dist: number } | null =
        null;
      for (const lvl of lookups.levels.all) {
        const d = levenshteinDistance(
          levelRaw.toLowerCase(),
          lvl.name.toLowerCase(),
        );
        if (d <= 3 && (!bestSuggestion || d < bestSuggestion.dist)) {
          bestSuggestion = { id: lvl.id, name: lvl.name, dist: d };
        }
      }

      if (resolution?.kind === "use_suggested_level") {
        const levelId = (resolution.payload as { levelId?: string })?.levelId;
        if (levelId) {
          resolvedLevelId = levelId;
          findings.push({
            row: rowNumber,
            rule: "unknown_level",
            severity: "warning",
            message: `Using selected level for "${levelRaw}".`,
            resolution,
          });
        }
      } else if (resolution?.kind === "exclude_enrolment") {
        // Drop the enrolment but keep family + student.
        findings.push({
          row: rowNumber,
          rule: "unknown_level",
          severity: "warning",
          message: `Excluding enrolment for unknown level "${levelRaw}".`,
          resolution,
        });
      } else if (resolution?.kind === "exclude_row") {
        // Whole row excluded; no further work.
      } else {
        findings.push({
          row: rowNumber,
          rule: "unknown_level",
          severity: "error",
          message: bestSuggestion
            ? `Level "${levelRaw}" not found — did you mean "${bestSuggestion.name}"?`
            : `Level "${levelRaw}" not found in this school.`,
          resolution: bestSuggestion
            ? {
                kind: "use_suggested_level",
                payload: { levelId: bestSuggestion.id },
              }
            : undefined,
        });
      }
    }

    // Rule 4 — capacity. Only fires once we know the level + day + time;
    // class lookup is by (levelId, day, time).
    if (resolvedLevelId && day && time) {
      const key = `${resolvedLevelId}|${day}|${time}`;
      const cls = lookups.classes.byKey.get(key);
      if (cls) {
        resolvedClass = cls;
        const existing = lookups.classes.existingEnrolments.get(cls.classId) ?? 0;
        const proposedKey = cls.classId;
        const proposed = lookups.proposedEnrolments.get(proposedKey) ?? 0;
        if (existing + proposed + 1 > cls.capacity) {
          findings.push({
            row: rowNumber,
            rule: "capacity_breach",
            severity: "warning",
            message: `Class would be over capacity by ${existing + proposed + 1 - cls.capacity} (${existing + proposed + 1}/${cls.capacity}).`,
          });
        }
      }
    }
  }

  // Decide the row outcome.
  if (resolution?.kind === "exclude_row") {
    return { kind: "findings", findings };
  }

  const blocking = findings.some((f) => f.severity === "error");
  if (blocking) {
    return { kind: "findings", findings };
  }

  // Insertable. Determine merge target if resolution says so.
  const existingFamilyId = email
    ? lookups.existingFamilies.get(email) ?? null
    : null;
  const mergeIntoFamilyId =
    resolution?.kind === "merge" && existingFamilyId
      ? ((resolution.payload as { existingFamilyId?: string })
          ?.existingFamilyId ?? existingFamilyId)
      : null;

  const includeEnrolment =
    enrolmentComplete &&
    resolution?.kind !== "exclude_enrolment" &&
    resolvedLevelId !== null &&
    resolvedDay !== null &&
    resolvedTime !== null &&
    resolvedFrequency !== null &&
    resolvedClass !== null;

  if (includeEnrolment && resolvedClass) {
    lookups.proposedEnrolments.set(
      resolvedClass.classId,
      (lookups.proposedEnrolments.get(resolvedClass.classId) ?? 0) + 1,
    );
  }

  return {
    kind: "insert",
    findings,
    family: {
      primaryContactName: cellAt(row, nameIdx).trim() || email,
      primaryContactEmail: email,
      primaryContactPhone: phoneIdx >= 0 ? cellAt(row, phoneIdx).trim() || null : null,
      mergeIntoFamilyId,
    },
    student: {
      firstName,
      lastName,
      dateOfBirth: dob,
    },
    enrolment: includeEnrolment
      ? {
          levelId: resolvedLevelId!,
          day: resolvedDay!,
          time: resolvedTime!,
          frequency: resolvedFrequency!,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Lookups loader. Populates the per-pass cache the row processor reads from.
// One transaction-scoped read per relation; RLS scopes to current school.
// ---------------------------------------------------------------------------

async function loadLookups(db: DbClient): Promise<{
  levels: LevelLookup;
  classes: ClassLookup;
  existingFamilies: ExistingFamilyLookup;
}> {
  const [levelRows, classRows, enrolmentCountRows, familyRows] =
    await Promise.all([
      db.classLevel.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true, ratio: true },
      }),
      db.class.findMany({
        where: { deletedAt: null },
        select: {
          id: true,
          levelId: true,
          dayOfWeek: true,
          startTime: true,
          capacity: true,
        },
      }),
      db.enrolment.findMany({
        where: { status: EnrolmentStatus.Active },
        select: { classId: true },
      }),
      db.family.findMany({
        where: { deletedAt: null },
        select: { id: true, primaryContactEmail: true },
      }),
    ]);

  const byNameLower = new Map<string, { id: string; ratio: number; name: string }>();
  for (const l of levelRows) {
    byNameLower.set(l.name.toLowerCase(), {
      id: l.id,
      ratio: l.ratio,
      name: l.name,
    });
  }

  const byKey = new Map<string, { classId: string; capacity: number }>();
  for (const c of classRows) {
    // startTime round-trips as a Date anchored at 1970-01-01 — slice to
    // HH:MM to align with the parsed-cell time format.
    const hhmm = c.startTime.toISOString().slice(11, 16);
    byKey.set(`${c.levelId}|${c.dayOfWeek}|${hhmm}`, {
      classId: c.id,
      capacity: c.capacity,
    });
  }

  const existingEnrolments = new Map<string, number>();
  for (const e of enrolmentCountRows) {
    existingEnrolments.set(e.classId, (existingEnrolments.get(e.classId) ?? 0) + 1);
  }

  const existingFamilies: ExistingFamilyLookup = new Map();
  for (const f of familyRows) {
    existingFamilies.set(f.primaryContactEmail.toLowerCase(), f.id);
  }

  return {
    levels: { byNameLower, all: Array.from(byNameLower.values()) },
    classes: { byKey, existingEnrolments },
    existingFamilies,
  };
}

// ---------------------------------------------------------------------------
// dryRunImport — runs the full import logic inside a SAVEPOINT, then
// rolls the savepoint back so no data is committed. Returns the report.
//
// Decision #1: SAVEPOINT (vs nested $transaction or throw-and-catch).
// `withTenant` already opens a Prisma transaction; we issue a SAVEPOINT
// inside it via $executeRaw. The action's outer transaction can then go
// on to do other reads (or commit successfully); the dry-run's writes
// disappear. This composes cleanly with `withTenant` because Prisma's
// $transaction client carries the same connection through, so the
// SAVEPOINT and ROLLBACK TO SAVEPOINT see each other.
// ---------------------------------------------------------------------------

export async function dryRunImport(
  db: TenantTx,
  input: DryRunInput,
): Promise<ValidationReport> {
  // Open a savepoint so all mutations inside this call are reverted even
  // on success. The Postgres SAVEPOINT identifier is fixed (no operator
  // input flows into it), so no SQL injection surface.
  await db.$executeRawUnsafe("SAVEPOINT dry_run_import");
  try {
    const { findings, preview } = await runImportPass(db, input, {
      persistBatch: false,
    });
    const blocking = findings.some((f) => f.severity === "error");
    return { findings, preview, blocking };
  } finally {
    await db.$executeRawUnsafe("ROLLBACK TO SAVEPOINT dry_run_import");
    await db.$executeRawUnsafe("RELEASE SAVEPOINT dry_run_import");
  }
}

// ---------------------------------------------------------------------------
// commitImport — re-validates with resolutions applied, then writes
// families / students / enrolments inside the open transaction. If
// re-validation produces any blocking finding, no rows are written and
// the report is returned to the caller.
// ---------------------------------------------------------------------------

export async function commitImport(
  db: TenantTx,
  input: CommitInput,
): Promise<
  | { ok: true; result: CommitResult }
  | { ok: false; report: ValidationReport }
> {
  // Re-validate inside a savepoint first so the validation pass can use
  // the same write-and-rollback shape dryRunImport does. If validation
  // is clean, the savepoint is released and we commit for real.
  await db.$executeRawUnsafe("SAVEPOINT commit_import_validate");
  let report: ValidationReport;
  try {
    const { findings, preview } = await runImportPass(db, input, {
      persistBatch: false,
    });
    report = {
      findings,
      preview,
      blocking: findings.some((f) => f.severity === "error"),
    };
  } finally {
    await db.$executeRawUnsafe("ROLLBACK TO SAVEPOINT commit_import_validate");
    await db.$executeRawUnsafe("RELEASE SAVEPOINT commit_import_validate");
  }

  if (report.blocking) {
    return { ok: false, report };
  }

  // Fresh pass — this one persists. The batch row is created first so
  // subsequent inserts can FK-reference it.
  const { result } = await runImportPass(db, input, { persistBatch: true });
  if (!result) {
    // Defensive — only happens if the persistBatch pass somehow finds new
    // blocking findings. Bubble the report up.
    return {
      ok: false,
      report: {
        findings: [
          {
            row: 0,
            rule: "missing_required",
            severity: "error",
            message: "Validation passed on dry-run but failed on commit.",
          },
        ],
        preview: { familyCount: 0, studentCount: 0, enrolmentCount: 0 },
        blocking: true,
      },
    };
  }
  return { ok: true, result };
}

// ---------------------------------------------------------------------------
// Single-pass driver. Used by both dryRun (persistBatch=false) and commit
// (persistBatch=true). Returns the report and, when persisting, the
// committed batch summary.
// ---------------------------------------------------------------------------

async function runImportPass(
  db: TenantTx,
  input: DryRunInput,
  opts: { persistBatch: boolean },
): Promise<{
  findings: Finding[];
  preview: { familyCount: number; studentCount: number; enrolmentCount: number };
  result?: CommitResult;
}> {
  const lookups = await loadLookups(db);
  const proposedEnrolments = new Map<string, number>();
  const seenEmails = new Map<string, number[]>();
  const findings: Finding[] = [];

  // Insertion plan, accumulated row-by-row. Email → list of rows that
  // share it within this batch (used to dedupe within-batch family
  // creation).
  type PlanFamily = {
    rowNumber: number;
    primaryContactName: string;
    primaryContactEmail: string;
    primaryContactPhone: string | null;
    mergeIntoFamilyId: string | null;
  };
  type PlanStudent = {
    rowNumber: number;
    emailKey: string;
    firstName: string;
    lastName: string;
    dateOfBirth: Date | null;
  };
  type PlanEnrolment = {
    rowNumber: number;
    studentRowNumber: number;
    classId: string;
    frequency: EnrolmentFrequency;
  };
  const familyPlans: PlanFamily[] = [];
  const studentPlans: PlanStudent[] = [];
  const enrolmentPlans: PlanEnrolment[] = [];

  for (let i = 0; i < input.rows.length; i++) {
    const rowNumber = i + 1;
    const row = input.rows[i]!;
    const resolution = input.resolutions[rowNumber];
    const outcome = processRow({
      row,
      rowNumber,
      headers: input.headers,
      mapping: input.mapping,
      resolution,
      lookups: {
        levels: lookups.levels,
        classes: lookups.classes,
        existingFamilies: lookups.existingFamilies,
        proposedEnrolments,
        seenEmails,
      },
    });

    // Track emails after processing so duplicate flagging compares
    // against earlier rows only (later rows will see this one).
    const email = ((): string | null => {
      const idx = findSourceIndex(
        input.mapping,
        input.headers,
        "family.primary_contact_email",
      );
      if (idx < 0) return null;
      const v = (row[idx] ?? "").trim().toLowerCase();
      return v || null;
    })();
    if (email) {
      const arr = seenEmails.get(email) ?? [];
      arr.push(rowNumber);
      seenEmails.set(email, arr);
    }

    if (outcome.kind === "findings") {
      findings.push(...outcome.findings);
      continue;
    }
    findings.push(...outcome.findings);

    familyPlans.push({
      rowNumber,
      primaryContactName: outcome.family.primaryContactName,
      primaryContactEmail: outcome.family.primaryContactEmail,
      primaryContactPhone: outcome.family.primaryContactPhone,
      mergeIntoFamilyId: outcome.family.mergeIntoFamilyId,
    });
    studentPlans.push({
      rowNumber,
      emailKey: outcome.family.primaryContactEmail,
      firstName: outcome.student.firstName,
      lastName: outcome.student.lastName,
      dateOfBirth: outcome.student.dateOfBirth,
    });
    if (outcome.enrolment) {
      enrolmentPlans.push({
        rowNumber,
        studentRowNumber: rowNumber,
        classId: lookups.classes.byKey.get(
          `${outcome.enrolment.levelId}|${outcome.enrolment.day}|${outcome.enrolment.time}`,
        )!.classId,
        frequency: outcome.enrolment.frequency,
      });
    }
  }

  // Within-batch dedupe — multiple rows with the same email go onto one
  // family. The first row wins as the family's contact name.
  type FamilyKey = string; // emailLower OR "merge:<existingId>"
  const familyByKey = new Map<
    FamilyKey,
    { rowNumber: number; data: PlanFamily; resolvedId: string | null }
  >();
  for (const fp of familyPlans) {
    const key = fp.mergeIntoFamilyId
      ? `merge:${fp.mergeIntoFamilyId}`
      : fp.primaryContactEmail;
    if (!familyByKey.has(key)) {
      familyByKey.set(key, {
        rowNumber: fp.rowNumber,
        data: fp,
        resolvedId: fp.mergeIntoFamilyId,
      });
    }
  }

  const preview = {
    familyCount: Array.from(familyByKey.values()).filter(
      (v) => v.resolvedId === null,
    ).length,
    studentCount: studentPlans.length,
    enrolmentCount: enrolmentPlans.length,
  };

  if (!opts.persistBatch) {
    return { findings, preview };
  }

  // Persist. Order: import_batches row → families → students → enrolments.
  // The batch row exists first so each subsequent row can carry batch_id.
  const schoolId = getSchoolId();
  if (!schoolId) {
    throw new Error(
      "importRepository.commitImport: no schoolId in tenant context",
    );
  }

  const batch = await db.importBatch.create({
    data: {
      schoolId,
      mapping: input.mapping as unknown as Prisma.InputJsonValue,
      rowCount: input.rows.length,
      familyCount: preview.familyCount,
      studentCount: preview.studentCount,
      enrolmentCount: preview.enrolmentCount,
    } as unknown as Prisma.ImportBatchCreateInput,
  });

  // Create families and resolve their ids.
  for (const entry of familyByKey.values()) {
    if (entry.resolvedId !== null) continue; // merge target — already exists
    const created = await db.family.create({
      data: {
        schoolId,
        primaryContactName: entry.data.primaryContactName,
        primaryContactEmail: entry.data.primaryContactEmail,
        primaryContactPhone: entry.data.primaryContactPhone,
        batchId: batch.id,
      } as unknown as Prisma.FamilyCreateInput,
    });
    entry.resolvedId = created.id;
  }

  // Map row → familyId (resolved or merged).
  const familyIdByRow = new Map<number, string>();
  for (const fp of familyPlans) {
    const key = fp.mergeIntoFamilyId
      ? `merge:${fp.mergeIntoFamilyId}`
      : fp.primaryContactEmail;
    const entry = familyByKey.get(key);
    if (entry?.resolvedId) familyIdByRow.set(fp.rowNumber, entry.resolvedId);
  }

  // Students.
  const studentIdByRow = new Map<number, string>();
  for (const sp of studentPlans) {
    const familyId = familyIdByRow.get(sp.rowNumber);
    if (!familyId) continue;
    const created = await db.student.create({
      data: {
        schoolId,
        familyId,
        firstName: sp.firstName,
        lastName: sp.lastName,
        // DOB is optional in this importer; when missing, store the epoch
        // sentinel only if the column required a value. The schema makes
        // it NOT NULL — so we use 1970-01-01 as a placeholder that the
        // operator can correct later via the dashboard. Tracked in the
        // handoff (decision #4) — flagged for reconsideration.
        dateOfBirth: sp.dateOfBirth ?? new Date(Date.UTC(1970, 0, 1)),
        status: StudentStatus.Active,
        batchId: batch.id,
      } as unknown as Prisma.StudentCreateInput,
    });
    studentIdByRow.set(sp.rowNumber, created.id);
  }

  // Enrolments.
  for (const ep of enrolmentPlans) {
    const studentId = studentIdByRow.get(ep.studentRowNumber);
    if (!studentId) continue;
    await db.enrolment.create({
      data: {
        schoolId,
        studentId,
        classId: ep.classId,
        frequency: ep.frequency,
        startDate: new Date(),
        status: EnrolmentStatus.Active,
        batchId: batch.id,
      } as unknown as Prisma.EnrolmentCreateInput,
    });
  }

  return {
    findings,
    preview,
    result: {
      batchId: batch.id,
      familyCount: preview.familyCount,
      studentCount: preview.studentCount,
      enrolmentCount: preview.enrolmentCount,
    },
  };
}

// ---------------------------------------------------------------------------
// rollbackImport — deletes rows tagged with this batch in FK order, then
// stamps `rolled_back_at` on the batch row. Idempotent: a second call on
// an already-rolled-back batch returns `{ alreadyRolledBack: true }`
// without error.
// ---------------------------------------------------------------------------

export async function rollbackImport(
  db: TenantTx,
  batchId: string,
): Promise<{ alreadyRolledBack: boolean }> {
  const batch = await db.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) {
    // RLS hides cross-tenant batches; surface as not-found at the action
    // layer via the caller's pre-check.
    throw new Error(`import batch ${batchId} not found`);
  }
  if (batch.rolledBackAt) {
    return { alreadyRolledBack: true };
  }

  // Delete in FK order. Skip-deleted rows (deletedAt set by other code)
  // are still removed — rollback's intent is "undo this batch", and any
  // soft-deleted descendant of the batch is still attached to it.
  await db.enrolment.deleteMany({ where: { batchId } });
  await db.student.deleteMany({ where: { batchId } });
  await db.family.deleteMany({ where: { batchId } });
  await db.importBatch.update({
    where: { id: batchId },
    data: { rolledBackAt: new Date() },
  });

  return { alreadyRolledBack: false };
}

// ---------------------------------------------------------------------------
// Reads used by other surfaces (the action layer's pre-check, the
// "committed batch summary" pane, the wizard's `markImportComplete`
// gate).
// ---------------------------------------------------------------------------

type ImportBatchRow = Prisma.ImportBatchGetPayload<Record<string, never>>;

function toImportBatch(row: ImportBatchRow): ImportBatch {
  return {
    id: row.id,
    schoolId: row.schoolId,
    mapping: row.mapping as ImportMapping,
    rowCount: row.rowCount,
    familyCount: row.familyCount,
    studentCount: row.studentCount,
    enrolmentCount: row.enrolmentCount,
    committedAt: row.committedAt,
    rolledBackAt: row.rolledBackAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getById(
  db: DbClient,
  id: string,
): Promise<ImportBatch | null> {
  const row = await db.importBatch.findUnique({ where: { id } });
  return row ? toImportBatch(row) : null;
}

export async function listCommitted(db: DbClient): Promise<ImportBatch[]> {
  const rows = await db.importBatch.findMany({
    where: { rolledBackAt: null, deletedAt: null },
    orderBy: { committedAt: "desc" },
  });
  return rows.map(toImportBatch);
}

export async function countCommitted(db: DbClient): Promise<number> {
  return db.importBatch.count({
    where: { rolledBackAt: null, deletedAt: null },
  });
}
