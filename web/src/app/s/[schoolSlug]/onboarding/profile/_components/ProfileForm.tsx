"use client";

import { useActionState, useRef, useState } from "react";
import { uploadSchoolLogo } from "../_actions/uploadSchoolLogo";
import {
  type ProfileFormState,
  initialProfileFormState,
  saveProfileForm,
} from "../_actions/saveProfileForm";

export type ProfileFormInitialValues = {
  legalName: string | null;
  tradingName: string | null;
  abn: string | null;
  gstRegistered: boolean | null;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  primaryContactPhone: string | null;
  // Storage path (e.g. `<school_id>/logo/<uuid>.png`). NOT a URL.
  logoPath: string | null;
  // Signed URL for `logoPath` produced server-side at page render. The
  // client renders it as a preview; on a fresh upload we fall back to a
  // local object URL until the next page render.
  logoSignedUrl: string | null;
  schoolSlug: string;
  currency: string;
};

const FIELD_LABEL: React.CSSProperties = { fontWeight: 500 };

export function ProfileForm({ initial }: { initial: ProfileFormInitialValues }) {
  // useActionState wires the action through React. The bound first
  // argument carries the slug so the action can issue a typed redirect
  // without re-reading the URL on the server.
  const boundAction = saveProfileForm.bind(null, initial.schoolSlug);
  const [state, formAction, pending] = useActionState<
    ProfileFormState,
    FormData
  >(boundAction, initialProfileFormState);

  // Logo upload runs in its own request the moment the user picks a
  // file. We keep two pieces of client state: the storage path (the
  // load-bearing value, posted as a hidden field on save) and a preview
  // URL (an object URL we keep in sync, just for the eyes). On
  // validation error the page re-renders with the previous logoPath
  // intact (the hidden field carries it), so a saved logo isn't lost.
  const [logoPath, setLogoPath] = useState<string | null>(initial.logoPath);
  const [logoPreview, setLogoPreview] = useState<string | null>(
    initial.logoSignedUrl,
  );
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function onLogoPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoUploading(true);
    setLogoError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const result = await uploadSchoolLogo(fd);
      if (!result.ok) {
        setLogoError(result.error.message);
        // Reset the input so picking the same file again still fires onChange.
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      setLogoPath(result.data.path);
      const localUrl = URL.createObjectURL(file);
      setLogoPreview((prev) => {
        if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
        return localUrl;
      });
    } finally {
      setLogoUploading(false);
    }
  }

  function fieldError(name: keyof ProfileFormState["fieldErrors"]) {
    const msg = state.fieldErrors[name];
    if (!msg) return null;
    return (
      <p className="text-sm text-red-600" role="alert">
        {msg}
      </p>
    );
  }

  return (
    <form action={formAction} className="flex w-full max-w-2xl flex-col gap-6">
      {state.fieldErrors._form ? (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
        >
          {state.fieldErrors._form}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <label htmlFor="legalName" style={FIELD_LABEL} className="text-sm">
          Legal name
        </label>
        <input
          id="legalName"
          name="legalName"
          type="text"
          defaultValue={initial.legalName ?? ""}
          maxLength={200}
          className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
        {fieldError("legalName")}
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="tradingName" style={FIELD_LABEL} className="text-sm">
          Trading name
        </label>
        <input
          id="tradingName"
          name="tradingName"
          type="text"
          defaultValue={initial.tradingName ?? ""}
          maxLength={200}
          className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
        {fieldError("tradingName")}
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="abn" style={FIELD_LABEL} className="text-sm">
          ABN
        </label>
        <input
          id="abn"
          name="abn"
          type="text"
          inputMode="numeric"
          defaultValue={initial.abn ?? ""}
          placeholder="11 digits — spaces are stripped"
          className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
        {fieldError("abn")}
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend style={FIELD_LABEL} className="text-sm">
          GST registered?
        </legend>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="gstRegistered"
              value="yes"
              defaultChecked={initial.gstRegistered === true}
            />
            Yes
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="gstRegistered"
              value="no"
              defaultChecked={initial.gstRegistered !== true}
            />
            No
          </label>
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <label
          htmlFor="primaryContactName"
          style={FIELD_LABEL}
          className="text-sm"
        >
          Primary contact name
        </label>
        <input
          id="primaryContactName"
          name="primaryContactName"
          type="text"
          defaultValue={initial.primaryContactName ?? ""}
          maxLength={200}
          className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
        {fieldError("primaryContactName")}
      </div>

      <div className="flex flex-col gap-2">
        <label
          htmlFor="primaryContactEmail"
          style={FIELD_LABEL}
          className="text-sm"
        >
          Primary contact email
        </label>
        <input
          id="primaryContactEmail"
          name="primaryContactEmail"
          type="email"
          defaultValue={initial.primaryContactEmail ?? ""}
          className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
        {fieldError("primaryContactEmail")}
      </div>

      <div className="flex flex-col gap-2">
        <label
          htmlFor="primaryContactPhone"
          style={FIELD_LABEL}
          className="text-sm"
        >
          Primary contact phone
        </label>
        <input
          id="primaryContactPhone"
          name="primaryContactPhone"
          type="tel"
          defaultValue={initial.primaryContactPhone ?? ""}
          maxLength={50}
          className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
        {fieldError("primaryContactPhone")}
      </div>

      <div className="flex flex-col gap-2">
        <span style={FIELD_LABEL} className="text-sm">
          Logo
        </span>
        {logoPreview ? (
          <img
            src={logoPreview}
            alt="School logo"
            className="h-24 w-auto rounded border border-zinc-200 dark:border-zinc-800"
          />
        ) : null}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={onLogoPick}
          disabled={logoUploading}
          className="text-sm"
        />
        <input type="hidden" name="logoUrl" value={logoPath ?? ""} />
        {logoUploading ? (
          <p className="text-sm text-zinc-500">Uploading…</p>
        ) : null}
        {logoError ? (
          <p className="text-sm text-red-600" role="alert">
            {logoError}
          </p>
        ) : null}
        <p className="text-xs text-zinc-500">PNG, JPEG, or WEBP — up to 2MB.</p>
      </div>

      <div className="flex flex-col gap-2">
        <span style={FIELD_LABEL} className="text-sm">
          Currency
        </span>
        <input
          type="text"
          value={initial.currency}
          disabled
          aria-readonly="true"
          className="rounded border border-zinc-300 px-3 py-2 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <p className="text-xs text-zinc-500">
          Multi-currency is out of MVP scope.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
        <button
          type="submit"
          name="intent"
          value="skip"
          disabled={pending || logoUploading}
          className="rounded-full border border-zinc-300 px-5 py-2 text-sm dark:border-zinc-700"
        >
          Skip for now
        </button>
        <button
          type="submit"
          name="intent"
          value="save"
          disabled={pending || logoUploading}
          className="rounded-full bg-foreground px-5 py-2 text-sm text-background"
        >
          {pending ? "Saving…" : "Save and continue"}
        </button>
      </div>
    </form>
  );
}
