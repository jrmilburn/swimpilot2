"use client";

import {
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import type { ImportMapping } from "@/domain/types";
import type {
  Finding,
  ResolutionMap,
} from "@/repositories/importRepository";
import {
  type ImportFormState,
  initialImportFormState,
  saveImportForm,
} from "../_actions/saveImportForm";
import { MappingPanel } from "./MappingPanel";

type Props = { schoolSlug: string };

// Page shell. Holds the mapping + resolutions client-side so the
// MappingPanel can be controlled from the outside (the AI suggestions
// panel will live here once Chunk 3 lands), and so resolutions
// persist across dry-runs without round-tripping through the server.

export function ImportWorkspace({ schoolSlug }: Props) {
  const boundAction = saveImportForm.bind(null, schoolSlug);
  const [state, action, pending] = useActionState<ImportFormState, FormData>(
    boundAction,
    initialImportFormState,
  );

  const [csvText, setCsvText] = useState<string>("");
  const [mapping, setMapping] = useState<ImportMapping>({});
  const [resolutions, setResolutions] = useState<ResolutionMap>({});
  const [, startTransition] = useTransition();

  // After parse-csv, server hands back a default mapping; mirror it
  // into local state so the MappingPanel renders. Server is the source
  // of truth for the headers; client owns the working draft of the
  // mapping after that.
  const lastSeenCsvRef = useRef<typeof state.csv>(null);
  useEffect(() => {
    if (state.csv && state.csv !== lastSeenCsvRef.current) {
      lastSeenCsvRef.current = state.csv;
      // Use the server-side mapping if it set one (after dry-run); else
      // start from "ignore everywhere" and let the operator pick.
      setMapping(state.mapping ?? blankMapping(state.csv.headers));
      setResolutions(state.resolutions ?? {});
    }
  }, [state.csv, state.mapping, state.resolutions]);

  const headers = state.csv?.headers ?? [];
  const previewRows = state.csv?.rows.slice(0, 5) ?? [];

  function submit(intent: string, extras: Record<string, string> = {}) {
    const fd = new FormData();
    fd.set("intent", intent);
    fd.set("csvText", csvText);
    fd.set("mapping", JSON.stringify(mapping));
    fd.set("resolutions", JSON.stringify(resolutions));
    for (const [k, v] of Object.entries(extras)) fd.set(k, v);
    startTransition(() => action(fd));
  }

  return (
    <form
      className="flex w-full max-w-5xl flex-col gap-6"
      onSubmit={(e) => e.preventDefault()}
    >
      {state.fieldErrors._form ? (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
        >
          {state.fieldErrors._form}
        </div>
      ) : null}

      <CsvIntakePane
        csvText={csvText}
        onCsvTextChange={setCsvText}
        onParse={() => submit("parse-csv")}
        pending={pending}
        phase={state.phase}
        rowCount={state.csv?.rows.length ?? 0}
      />

      {state.csv && headers.length > 0 ? (
        <div className="grid gap-6 md:grid-cols-2">
          <div className="flex flex-col gap-3">
            <PreviewPane headers={headers} rows={previewRows} />
            <MappingPanel
              headers={headers}
              value={mapping}
              onChange={setMapping}
              disabled={pending || state.phase === "committed"}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => submit("dry-run")}
                disabled={pending || state.phase === "committed"}
                className="rounded-full border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
              >
                {pending ? "Validating…" : "Validate (dry run)"}
              </button>
              <button
                type="button"
                onClick={() => submit("commit")}
                disabled={
                  pending ||
                  state.phase === "committed" ||
                  (state.report?.blocking ?? true)
                }
                className="rounded-full bg-foreground px-5 py-2 text-sm text-background disabled:opacity-50"
                title={
                  state.report?.blocking
                    ? "Resolve blocking findings before committing."
                    : undefined
                }
              >
                {pending ? "Committing…" : "Commit import"}
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <ReportPane
              phase={state.phase}
              report={state.report}
              committed={state.commit}
              resolutions={resolutions}
              onResolutionChange={(row, next) =>
                setResolutions((prev) => {
                  const out: ResolutionMap = { ...prev };
                  if (next) out[row] = next;
                  else delete out[row];
                  return out;
                })
              }
              onRollback={(batchId) =>
                submit("rollback", { batchId })
              }
              pending={pending}
            />
          </div>
        </div>
      ) : null}

      <FinishControls
        canSave={state.phase === "committed"}
        pending={pending}
        onSubmit={(intent) => {
          // Save / skip submit through the same bridge — these are the
          // terminal intents that redirect on success.
          const fd = new FormData();
          fd.set("intent", intent);
          startTransition(() => action(fd));
        }}
      />
    </form>
  );
}

function blankMapping(headers: string[]): ImportMapping {
  const out: ImportMapping = {};
  for (const h of headers) out[h] = "ignore";
  return out;
}

function CsvIntakePane({
  csvText,
  onCsvTextChange,
  onParse,
  pending,
  phase,
  rowCount,
}: {
  csvText: string;
  onCsvTextChange: (next: string) => void;
  onParse: () => void;
  pending: boolean;
  phase: ImportFormState["phase"];
  rowCount: number;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <header className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
          1 · Paste or upload your CSV
        </h3>
        <p className="text-xs text-zinc-500">
          Up to 1 MB and 1,000 rows. Header row required.{" "}
          <a
            href="/onboarding/import-sample.csv"
            download
            className="underline"
          >
            Download a sample
          </a>
          .
        </p>
      </header>
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const text = await file.text();
          onCsvTextChange(text);
        }}
        className="text-xs"
      />
      <textarea
        value={csvText}
        onChange={(e) => onCsvTextChange(e.target.value)}
        placeholder="Or paste CSV content here…"
        rows={6}
        className="w-full rounded-md border border-zinc-200 bg-zinc-50 p-2 font-mono text-xs dark:border-zinc-800 dark:bg-zinc-900"
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-500">
          {phase !== "idle" && rowCount > 0
            ? `${rowCount} row${rowCount === 1 ? "" : "s"} parsed.`
            : "Pick a file or paste CSV text, then parse."}
        </span>
        <button
          type="button"
          onClick={onParse}
          disabled={pending || !csvText.trim()}
          className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm dark:border-zinc-700"
        >
          {pending ? "Parsing…" : "Parse CSV"}
        </button>
      </div>
    </section>
  );
}

function PreviewPane({
  headers,
  rows,
}: {
  headers: string[];
  rows: string[][];
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        First {rows.length} row{rows.length === 1 ? "" : "s"}
      </p>
      <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-xs">
          <thead className="bg-zinc-50 dark:bg-zinc-900">
            <tr>
              {headers.map((h) => (
                <th
                  key={h}
                  className="border-b border-zinc-200 px-2 py-1 text-left font-mono text-zinc-700 dark:border-zinc-800 dark:text-zinc-300"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {headers.map((_, j) => (
                  <td
                    key={j}
                    className="border-b border-zinc-200 px-2 py-1 text-zinc-600 dark:border-zinc-800 dark:text-zinc-400"
                  >
                    {row[j] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReportPane({
  phase,
  report,
  committed,
  resolutions,
  onResolutionChange,
  onRollback,
  pending,
}: {
  phase: ImportFormState["phase"];
  report: ImportFormState["report"];
  committed: ImportFormState["commit"];
  resolutions: ResolutionMap;
  onResolutionChange: (
    row: number,
    next: ResolutionMap[number] | null,
  ) => void;
  onRollback: (batchId: string) => void;
  pending: boolean;
}) {
  const grouped = useMemo(() => groupByRow(report?.findings ?? []), [report]);

  if (phase === "committed" && committed) {
    return (
      <section
        data-testid="commit-summary"
        className="flex flex-col gap-3 rounded-md border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-700 dark:bg-emerald-950"
      >
        <h3 className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">
          Import committed
        </h3>
        <ul className="text-sm text-emerald-900 dark:text-emerald-100">
          <li>Families: {committed.familyCount}</li>
          <li>Students: {committed.studentCount}</li>
          <li>Enrolments: {committed.enrolmentCount}</li>
        </ul>
        <button
          type="button"
          disabled={pending}
          onClick={() => onRollback(committed.batchId)}
          className="self-start rounded-full border border-emerald-700 px-3 py-1 text-xs text-emerald-800 dark:text-emerald-200"
        >
          {pending ? "Rolling back…" : "Roll this batch back"}
        </button>
      </section>
    );
  }

  if (phase === "rolled_back") {
    return (
      <section className="rounded-md border border-zinc-200 bg-white p-4 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
        Batch rolled back. Adjust the mapping or upload a different CSV
        and try again.
      </section>
    );
  }

  if (!report) {
    return (
      <section className="rounded-md border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">
        Validate your mapping to see findings here.
      </section>
    );
  }

  return (
    <section
      data-testid="report-pane"
      className="flex flex-col gap-3 rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <header className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
          Validation report
        </h3>
        <span className="text-xs text-zinc-500">
          {report.preview.familyCount} families · {report.preview.studentCount}{" "}
          students · {report.preview.enrolmentCount} enrolments
        </span>
      </header>
      {report.findings.length === 0 ? (
        <p className="text-sm text-emerald-700 dark:text-emerald-300">
          No findings — ready to commit.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
          {Array.from(grouped.entries()).map(([row, findings]) => (
            <li key={row} className="flex flex-col gap-1 py-2">
              <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                Row {row}
              </p>
              {findings.map((f, i) => (
                <FindingRow
                  key={i}
                  finding={f}
                  current={resolutions[row]}
                  onChange={(next) => onResolutionChange(row, next)}
                />
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FindingRow({
  finding,
  current,
  onChange,
}: {
  finding: Finding;
  current: ResolutionMap[number] | undefined;
  onChange: (next: ResolutionMap[number] | null) => void;
}) {
  const tone =
    finding.severity === "error"
      ? "text-red-700 dark:text-red-300"
      : "text-amber-700 dark:text-amber-300";
  return (
    <div className="flex flex-col gap-1">
      <p className={`text-xs ${tone}`}>{finding.message}</p>
      {finding.rule === "duplicate_email" && finding.severity === "error" ? (
        <div className="flex gap-1 text-xs">
          <button
            type="button"
            onClick={() =>
              onChange({
                kind: "merge",
                payload: finding.resolution?.payload,
              })
            }
            className={btnClass(current?.kind === "merge")}
          >
            Merge
          </button>
          <button
            type="button"
            onClick={() => onChange({ kind: "exclude_row" })}
            className={btnClass(current?.kind === "exclude_row")}
          >
            Exclude row
          </button>
        </div>
      ) : null}
      {finding.rule === "unknown_level" && finding.severity === "error" ? (
        <div className="flex gap-1 text-xs">
          {finding.resolution?.kind === "use_suggested_level" ? (
            <button
              type="button"
              onClick={() =>
                onChange({
                  kind: "use_suggested_level",
                  payload: finding.resolution?.payload,
                })
              }
              className={btnClass(current?.kind === "use_suggested_level")}
            >
              Use suggested level
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onChange({ kind: "exclude_enrolment" })}
            className={btnClass(current?.kind === "exclude_enrolment")}
          >
            Skip enrolment
          </button>
          <button
            type="button"
            onClick={() => onChange({ kind: "exclude_row" })}
            className={btnClass(current?.kind === "exclude_row")}
          >
            Exclude row
          </button>
        </div>
      ) : null}
    </div>
  );
}

function btnClass(active: boolean): string {
  return active
    ? "rounded-full bg-foreground px-2 py-0.5 text-background"
    : "rounded-full border border-zinc-300 px-2 py-0.5 dark:border-zinc-700";
}

function groupByRow(findings: Finding[]): Map<number, Finding[]> {
  const out = new Map<number, Finding[]>();
  for (const f of findings) {
    const arr = out.get(f.row) ?? [];
    arr.push(f);
    out.set(f.row, arr);
  }
  return out;
}

function FinishControls({
  canSave,
  pending,
  onSubmit,
}: {
  canSave: boolean;
  pending: boolean;
  onSubmit: (intent: "save" | "skip") => void;
}) {
  return (
    <div className="flex justify-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <button
        type="button"
        onClick={() => onSubmit("skip")}
        disabled={pending}
        className="rounded-full border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
      >
        {pending ? "Working…" : "Skip for now"}
      </button>
      <button
        type="button"
        onClick={() => onSubmit("save")}
        disabled={pending || !canSave}
        title={
          canSave
            ? undefined
            : "Commit at least one CSV (or use Skip) before finishing."
        }
        className="rounded-full bg-foreground px-5 py-2 text-sm text-background disabled:opacity-50"
      >
        {pending ? "Finishing…" : "Finish setup"}
      </button>
    </div>
  );
}
