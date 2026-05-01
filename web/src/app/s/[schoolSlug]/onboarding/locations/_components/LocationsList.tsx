"use client";

import { useState, useTransition, useActionState } from "react";
import type { Location } from "@/domain/types";
import { addLocation } from "../_actions/addLocation";
import { updateLocation } from "../_actions/updateLocation";
import { archiveLocation } from "../_actions/archiveLocation";
import {
  type LocationsFormState,
  initialLocationsFormState,
  saveLocationsForm,
} from "../_actions/saveLocationsForm";

type LocationDraft = {
  name: string;
  addressLine: string;
  suburb: string;
  state: string;
  postcode: string;
  timezone: string;
  notes: string;
};

const FIELD_LABEL: React.CSSProperties = { fontWeight: 500 };

const emptyDraft = (timezoneDefault: string): LocationDraft => ({
  name: "",
  addressLine: "",
  suburb: "",
  state: "",
  postcode: "",
  timezone: timezoneDefault,
  notes: "",
});

const draftFromLocation = (
  loc: Location,
  timezoneDefault: string,
): LocationDraft => ({
  name: loc.name,
  addressLine: loc.addressLine ?? "",
  suburb: loc.suburb ?? "",
  state: loc.state ?? "",
  postcode: loc.postcode ?? "",
  timezone: loc.timezone ?? timezoneDefault,
  notes: loc.notes ?? "",
});

// Form values keep timezone as a string and we normalise empty / "uses
// school timezone" to null at submit time. If the operator types a
// custom value we persist it. The school-timezone default is rendered
// as the placeholder so a blank field reads as "uses the school's".
function normaliseTimezone(
  raw: string,
  schoolTimezone: string,
): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === schoolTimezone) return null;
  return trimmed;
}

function nullable(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

export function LocationsList({
  initial,
  schoolSlug,
  schoolTimezone,
}: {
  initial: Location[];
  schoolSlug: string;
  schoolTimezone: string;
}) {
  // We render directly off the server prop; mutations call their own
  // actions which `revalidatePath` to bring this back fresh. We do hold
  // some tiny client state for the inline editor (which row is open,
  // the in-flight draft) but the source of truth is `initial`.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState<boolean>(initial.length === 0);
  const [addDraft, setAddDraft] = useState<LocationDraft>(() =>
    emptyDraft(schoolTimezone),
  );
  const [editDraft, setEditDraft] = useState<LocationDraft>(() =>
    emptyDraft(schoolTimezone),
  );
  const [rowError, setRowError] = useState<{
    id: string | "new";
    message: string;
    fields?: Record<string, string>;
  } | null>(null);
  const [pending, startTransition] = useTransition();

  const boundAction = saveLocationsForm.bind(null, schoolSlug);
  const [continueState, continueAction, continuePending] = useActionState<
    LocationsFormState,
    FormData
  >(boundAction, initialLocationsFormState);

  const continueDisabled = initial.length === 0 || continuePending || pending;

  function startAdd() {
    setAddDraft(emptyDraft(schoolTimezone));
    setAdding(true);
    setRowError(null);
  }

  function startEdit(loc: Location) {
    setEditDraft(draftFromLocation(loc, schoolTimezone));
    setEditingId(loc.id);
    setRowError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setRowError(null);
  }

  function submitAdd() {
    setRowError(null);
    startTransition(async () => {
      const result = await addLocation({
        name: addDraft.name,
        addressLine: nullable(addDraft.addressLine),
        suburb: nullable(addDraft.suburb),
        state: nullable(addDraft.state),
        postcode: nullable(addDraft.postcode),
        timezone: normaliseTimezone(addDraft.timezone, schoolTimezone),
        notes: nullable(addDraft.notes),
      });
      if (!result.ok) {
        setRowError({
          id: "new",
          message: result.error.message,
          fields:
            result.error.code === "VALIDATION"
              ? result.error.fieldErrors
              : undefined,
        });
        return;
      }
      setAdding(false);
      setAddDraft(emptyDraft(schoolTimezone));
    });
  }

  function submitUpdate(id: string) {
    setRowError(null);
    startTransition(async () => {
      const result = await updateLocation({
        id,
        patch: {
          name: editDraft.name,
          addressLine: nullable(editDraft.addressLine),
          suburb: nullable(editDraft.suburb),
          state: nullable(editDraft.state),
          postcode: nullable(editDraft.postcode),
          timezone: normaliseTimezone(editDraft.timezone, schoolTimezone),
          notes: nullable(editDraft.notes),
        },
      });
      if (!result.ok) {
        setRowError({
          id,
          message: result.error.message,
          fields:
            result.error.code === "VALIDATION"
              ? result.error.fieldErrors
              : undefined,
        });
        return;
      }
      setEditingId(null);
    });
  }

  function submitArchive(id: string) {
    setRowError(null);
    startTransition(async () => {
      const result = await archiveLocation({ id });
      if (!result.ok) {
        setRowError({ id, message: result.error.message });
      }
    });
  }

  return (
    <div className="flex w-full max-w-2xl flex-col gap-6">
      <ul className="flex flex-col gap-3">
        {initial.map((loc) =>
          editingId === loc.id ? (
            <li
              key={loc.id}
              className="rounded-md border border-zinc-300 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-950"
            >
              <LocationEditor
                draft={editDraft}
                setDraft={setEditDraft}
                schoolTimezone={schoolTimezone}
                error={rowError?.id === loc.id ? rowError : null}
                disabled={pending}
                onCancel={cancelEdit}
                onSubmit={() => submitUpdate(loc.id)}
                submitLabel="Save"
              />
            </li>
          ) : (
            <li
              key={loc.id}
              className="flex items-start justify-between gap-3 rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
            >
              <div className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{loc.name}</span>
                <LocationSummary
                  location={loc}
                  schoolTimezone={schoolTimezone}
                />
              </div>
              <div className="flex gap-2 text-sm">
                <button
                  type="button"
                  onClick={() => startEdit(loc)}
                  disabled={pending}
                  className="rounded-full border border-zinc-300 px-3 py-1 dark:border-zinc-700"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => submitArchive(loc.id)}
                  disabled={pending}
                  className="rounded-full border border-red-300 px-3 py-1 text-red-700 dark:border-red-800 dark:text-red-300"
                >
                  Remove
                </button>
              </div>
            </li>
          ),
        )}
        {adding ? (
          <li className="rounded-md border border-zinc-300 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-950">
            <LocationEditor
              draft={addDraft}
              setDraft={setAddDraft}
              schoolTimezone={schoolTimezone}
              error={rowError?.id === "new" ? rowError : null}
              disabled={pending}
              onCancel={
                initial.length > 0
                  ? () => {
                      setAdding(false);
                      setRowError(null);
                    }
                  : null
              }
              onSubmit={submitAdd}
              submitLabel="Add location"
            />
          </li>
        ) : null}
      </ul>

      {!adding ? (
        <div>
          <button
            type="button"
            onClick={startAdd}
            disabled={pending}
            className="rounded-full border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
          >
            + Add another location
          </button>
        </div>
      ) : null}

      <form
        action={continueAction}
        className="flex flex-col items-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800"
      >
        {continueState.fieldErrors._form ? (
          <div
            role="alert"
            className="w-full rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
          >
            {continueState.fieldErrors._form}
          </div>
        ) : null}
        {initial.length === 0 ? (
          <p className="text-xs text-zinc-500">
            Add at least one location to continue.
          </p>
        ) : null}
        <button
          type="submit"
          disabled={continueDisabled}
          className="rounded-full bg-foreground px-5 py-2 text-sm text-background disabled:opacity-50"
        >
          {continuePending ? "Saving…" : "Continue"}
        </button>
      </form>
    </div>
  );
}

function LocationSummary({
  location,
  schoolTimezone,
}: {
  location: Location;
  schoolTimezone: string;
}) {
  const addressParts = [
    location.addressLine,
    location.suburb,
    location.state,
    location.postcode,
  ].filter((p): p is string => Boolean(p && p.trim()));

  return (
    <div className="flex flex-col gap-0.5 text-zinc-600 dark:text-zinc-400">
      {addressParts.length > 0 ? (
        <span>{addressParts.join(", ")}</span>
      ) : (
        <span className="italic">No address</span>
      )}
      {/*
        Decision: hide the timezone column when null and show "uses
        school timezone (X)" instead. The common case is operators
        leaving it blank, and a per-row "Australia/Sydney" repeated for
        every pool would be visual noise.
      */}
      {location.timezone ? (
        <span className="text-xs">Timezone: {location.timezone}</span>
      ) : (
        <span className="text-xs">
          Uses school timezone ({schoolTimezone})
        </span>
      )}
      {location.notes ? (
        <span className="mt-1 text-xs">{location.notes}</span>
      ) : null}
    </div>
  );
}

function LocationEditor({
  draft,
  setDraft,
  schoolTimezone,
  error,
  disabled,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  draft: LocationDraft;
  setDraft: (next: LocationDraft) => void;
  schoolTimezone: string;
  error: { message: string; fields?: Record<string, string> } | null;
  disabled: boolean;
  onCancel: (() => void) | null;
  onSubmit: () => void;
  submitLabel: string;
}) {
  const fieldErr = (name: string) => error?.fields?.[name];

  return (
    <div className="flex flex-col gap-3">
      {error && !error.fields ? (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
        >
          {error.message}
        </div>
      ) : null}

      <Field label="Name" error={fieldErr("name")}>
        <input
          type="text"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          maxLength={200}
          required
          className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </Field>

      <Field label="Address" error={fieldErr("addressLine")}>
        <input
          type="text"
          value={draft.addressLine}
          onChange={(e) =>
            setDraft({ ...draft, addressLine: e.target.value })
          }
          placeholder="48 King St"
          maxLength={200}
          className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </Field>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Suburb" error={fieldErr("suburb")}>
          <input
            type="text"
            value={draft.suburb}
            onChange={(e) => setDraft({ ...draft, suburb: e.target.value })}
            maxLength={120}
            className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </Field>
        <Field label="State" error={fieldErr("state")}>
          <input
            type="text"
            value={draft.state}
            onChange={(e) => setDraft({ ...draft, state: e.target.value })}
            placeholder="e.g. NSW"
            maxLength={60}
            className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </Field>
        <Field label="Postcode" error={fieldErr("postcode")}>
          <input
            type="text"
            value={draft.postcode}
            onChange={(e) => setDraft({ ...draft, postcode: e.target.value })}
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={20}
            className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </Field>
      </div>

      <Field label="Timezone" error={fieldErr("timezone")}>
        <input
          type="text"
          value={draft.timezone}
          onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
          placeholder={schoolTimezone}
          maxLength={80}
          className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <p className="text-xs text-zinc-500">
          Leave as the school&apos;s timezone unless this pool sits in a
          different one.
        </p>
      </Field>

      <Field label="Notes" error={fieldErr("notes")}>
        <textarea
          value={draft.notes}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          rows={2}
          maxLength={2000}
          className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </Field>

      <div className="flex justify-end gap-2 pt-1">
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={disabled}
            className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm dark:border-zinc-700"
          >
            Cancel
          </button>
        ) : null}
        <button
          type="button"
          onClick={onSubmit}
          disabled={disabled}
          className="rounded-full bg-foreground px-4 py-1.5 text-sm text-background"
        >
          {disabled ? "Saving…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span style={FIELD_LABEL} className="text-sm">
        {label}
      </span>
      {children}
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
