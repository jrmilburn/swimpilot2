import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth/requireTenant";
import { updateSchoolName } from "./_actions/updateSchoolName";

export default async function TenantHome({
  params,
}: {
  params: Promise<{ schoolSlug: string }>;
}) {
  const { schoolSlug } = await params;
  // Cached by `requireTenant`'s React.cache() — the layout already called
  // it for this same slug, so this is free.
  const { schoolName, role } = await requireTenant(schoolSlug);

  // Tiny FormData -> typed-input adapter at the call site, per the
  // architecture doc: keep `tenantAction` ergonomic for typed args, parse
  // FormData here.
  async function rename(formData: FormData) {
    "use server";
    const result = await updateSchoolName({ name: formData.get("name") });
    if (result.ok) {
      revalidatePath(`/s/${schoolSlug}`);
    }
    // Errors surface in the next iteration via useActionState; for now
    // the result is just dropped — this form exists to exercise the path.
  }

  return (
    <section className="flex flex-1 items-center justify-center p-8">
      <div className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome to {schoolName}
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          role: {role}
        </p>
        <form action={rename} className="flex items-center gap-2">
          <input
            name="name"
            defaultValue={schoolName}
            className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            aria-label="School name"
          />
          <button
            type="submit"
            className="rounded-full border px-3 py-1.5 text-sm"
          >
            Rename
          </button>
        </form>
      </div>
    </section>
  );
}
