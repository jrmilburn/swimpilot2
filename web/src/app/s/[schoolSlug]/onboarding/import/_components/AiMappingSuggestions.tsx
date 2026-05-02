"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { ImportMapping, ImportTargetField } from "@/domain/types";
import {
  suggestColumnMapping,
  type SuggestColumnMappingResult,
  type SuggestionConfidence,
  type SuggestionMapping,
} from "../_actions/suggestColumnMapping";

// AI column-mapping side panel. Sits beside `MappingPanel` inside
// `ImportWorkspace`. When the CSV is parsed and `headers` arrives, this
// panel fires `suggestColumnMapping` once and renders one of three
// states: pending, success (preview + Apply), or unavailable (a quiet
// note). It never blocks the operator — clicking "Validate" or "Commit"
// stays available no matter what AI returns.
//
// State is owned externally by `ImportWorkspace` (mapping + setMapping).
// This panel calls `onApply(mapping)` with its own draft, which the page
// then sets as the new mapping; the existing `MappingPanel` reflects the
// change because it is externally controllable. Confidence indicators
// live here, NOT inside `MappingPanel` — the contract test in
// `mappingPanelContract.test.ts` enforces that.

export type AiMappingSuggestionsProps = {
  headers: string[] | null;
  sampleRows: string[][] | null;
  onApply: (mapping: ImportMapping) => void;
};

type UnavailableReason = Extract<
  SuggestColumnMappingResult,
  { ok: false }
>["reason"];

type Status =
  | { kind: "idle" }
  | { kind: "pending" }
  | {
      kind: "ready";
      mapping: SuggestionMapping;
      confidence: SuggestionConfidence;
      applied: boolean;
    }
  | { kind: "unavailable"; reason: UnavailableReason };

const TARGET_LABELS: Record<ImportTargetField, string> = {
  "family.primary_contact_name": "Family · contact name",
  "family.primary_contact_email": "Family · contact email",
  "family.primary_contact_phone": "Family · contact phone",
  "student.first_name": "Student · first name",
  "student.last_name": "Student · last name",
  "student.date_of_birth": "Student · date of birth",
  "enrolment.level_name": "Enrolment · level name",
  "enrolment.day": "Enrolment · day",
  "enrolment.time": "Enrolment · time",
  "enrolment.frequency": "Enrolment · frequency",
};

export function AiMappingSuggestions({
  headers,
  sampleRows,
  onApply,
}: AiMappingSuggestionsProps) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [, startTransition] = useTransition();
  const fetchedForRef = useRef<string | null>(null);

  // Fire once per fresh parse. The dependency key is the headers tuple
  // (server is the source of truth — when it hands back new headers,
  // we re-fetch). A re-render with the same headers reference does
  // nothing.
  //
  // All state transitions go through `startTransition`. The
  // `react-hooks/set-state-in-effect` rule rejects synchronous
  // `setState` calls in an effect body; using a transition both
  // satisfies the rule and gives the parent room to keep handling
  // higher-priority work while AI is mapping.
  useEffect(() => {
    if (!headers || headers.length === 0) {
      // No headers means the wizard isn't past parse — the parent
      // doesn't render this panel at all in that case. Don't push a
      // synchronous state update from here; the initial `idle` state
      // already represents this.
      fetchedForRef.current = null;
      return;
    }
    const key = headers.join("\u0001");
    if (fetchedForRef.current === key) return;
    fetchedForRef.current = key;

    const rows = sampleRows ?? [];

    startTransition(async () => {
      setStatus({ kind: "pending" });
      const result = await suggestColumnMapping({
        headers,
        sampleRows: rows,
      });
      if (!result.ok) {
        // tenantAction-level failure (auth, validation, internal). The
        // panel doesn't surface specifics — degrade gracefully and let
        // the operator hand-map. The same `ai_calls` row, if relevant,
        // was already written by `withAI`.
        setStatus({ kind: "unavailable", reason: "ai_unavailable" });
        return;
      }
      const data = result.data;
      if (!data.ok) {
        setStatus({ kind: "unavailable", reason: data.reason });
        return;
      }
      setStatus({
        kind: "ready",
        mapping: data.mapping,
        confidence: data.confidence,
        applied: false,
      });
    });
  }, [headers, sampleRows]);

  if (status.kind === "idle") return null;

  if (status.kind === "pending") {
    return (
      <section
        data-testid="ai-mapping-suggestions"
        aria-live="polite"
        className="flex flex-col gap-2 rounded-md border border-zinc-200 bg-white p-3 text-xs dark:border-zinc-800 dark:bg-zinc-950"
      >
        <span className="font-medium uppercase tracking-wide text-zinc-500">
          AI suggestions
        </span>
        <span className="text-zinc-500">AI is mapping columns…</span>
      </section>
    );
  }

  if (status.kind === "unavailable") {
    return (
      <section
        data-testid="ai-mapping-suggestions"
        className="rounded-md border border-zinc-200 bg-white p-3 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950"
      >
        AI mapping unavailable — map columns manually.
      </section>
    );
  }

  const { mapping, confidence, applied } = status;
  const headerList = headers ?? [];

  return (
    <section
      data-testid="ai-mapping-suggestions"
      className="flex flex-col gap-2 rounded-md border border-zinc-200 bg-white p-3 text-xs dark:border-zinc-800 dark:bg-zinc-950"
    >
      <header className="flex items-center justify-between">
        <span className="font-medium uppercase tracking-wide text-zinc-500">
          AI suggestions
        </span>
        <button
          type="button"
          onClick={() => {
            // Translate the panel's draft (target | null) into the page's
            // mapping shape (target | "ignore"). null becomes "ignore"
            // so the manual pane shows the column as unmapped.
            const next: ImportMapping = {};
            for (const h of headerList) {
              const target = mapping[h];
              next[h] = target ?? "ignore";
            }
            onApply(next);
            setStatus({ ...status, applied: true });
          }}
          disabled={applied}
          className="rounded-full bg-foreground px-3 py-1 text-background disabled:opacity-50"
          data-testid="ai-mapping-apply"
        >
          {applied ? "✓ Applied" : "Apply suggestions"}
        </button>
      </header>
      <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
        {headerList.map((h) => {
          const target = mapping[h] ?? null;
          const conf = confidence[h] ?? "low";
          return (
            <li
              key={h}
              className="flex items-center justify-between gap-2 py-1"
            >
              <span className="truncate font-mono text-zinc-700 dark:text-zinc-300">
                {h}
              </span>
              <span className="flex items-center gap-2">
                <span className="text-zinc-500">
                  {target ? TARGET_LABELS[target] : "—"}
                </span>
                <ConfidenceBadge confidence={target ? conf : "low"} />
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ConfidenceBadge({
  confidence,
}: {
  confidence: "high" | "medium" | "low";
}) {
  if (confidence === "high") {
    return (
      <span
        title="High confidence"
        aria-label="High confidence"
        className="text-emerald-600 dark:text-emerald-400"
      >
        ✓
      </span>
    );
  }
  if (confidence === "medium") {
    return (
      <span
        title="Medium confidence"
        aria-label="Medium confidence"
        className="text-amber-500"
      >
        •
      </span>
    );
  }
  return (
    <span
      title="Low confidence"
      aria-label="Low confidence"
      className="text-zinc-400"
    >
      ?
    </span>
  );
}
