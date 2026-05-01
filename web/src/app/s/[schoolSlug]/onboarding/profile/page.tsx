import { requireTenant } from "@/lib/auth/requireTenant";
import { withTenant } from "@/lib/db/withTenant";
import * as schoolRepository from "@/repositories/schoolRepository";
import * as assetRepository from "@/repositories/assetRepository";
import { ProfileForm } from "./_components/ProfileForm";

// Sprint 4 / Chunk 2 — the Profile step body. Renders saved values,
// produces a signed URL for the existing logo (if any) so the preview
// works on first paint, and hands a typed initial-values object to the
// client form. The form action redirects on success — we don't need an
// inline `useFormState` here because the redirect throws and the page
// re-renders inside the wizard layout.
export default async function ProfileStepPage({
  params,
}: {
  params: Promise<{ schoolSlug: string }>;
}) {
  const { schoolSlug } = await params;
  const { schoolId, userId } = await requireTenant(schoolSlug);

  const school = await withTenant({ schoolId, userId }, (tx) =>
    schoolRepository.getById(tx, schoolId),
  );
  if (!school) {
    // requireTenant() should have already failed if the school is
    // missing, but guard the type narrowing for TS.
    throw new Error(`schoolRepository.getById returned null for ${schoolId}`);
  }

  // Produce a signed URL for the existing logo so the form's preview
  // works on first render. If signing fails (e.g. the path is stale and
  // the object's been deleted), swallow and fall through to "no
  // preview" rather than blowing up the wizard — the user can re-upload.
  let logoSignedUrl: string | null = null;
  if (school.logoUrl) {
    try {
      logoSignedUrl = await assetRepository.signSchoolAssetUrl(school.logoUrl);
    } catch (err) {
      console.error("[profile] failed to sign logo URL", err);
    }
  }

  return (
    <section className="flex flex-1 flex-col items-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h2 className="text-xl font-semibold tracking-tight">
            School profile
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Identity and branding. You can come back and edit any of this
            later. Skip if you&apos;d rather move on — nothing here is required to
            keep going.
          </p>
        </header>
        <ProfileForm
          initial={{
            legalName: school.legalName,
            tradingName: school.tradingName,
            abn: school.abn,
            gstRegistered: school.gstRegistered,
            primaryContactName: school.primaryContactName,
            primaryContactEmail: school.primaryContactEmail,
            primaryContactPhone: school.primaryContactPhone,
            logoPath: school.logoUrl,
            logoSignedUrl,
            schoolSlug,
            currency: school.currency,
          }}
        />
      </div>
    </section>
  );
}
