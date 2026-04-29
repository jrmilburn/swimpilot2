import { requireTenant } from "@/lib/auth/requireTenant";

export default async function TenantHome({
  params,
}: {
  params: Promise<{ schoolSlug: string }>;
}) {
  const { schoolSlug } = await params;
  // Cached by `requireTenant`'s React.cache() — the layout already called
  // it for this same slug, so this is free.
  const { schoolName, role } = await requireTenant(schoolSlug);

  return (
    <section className="flex flex-1 items-center justify-center p-8">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome to {schoolName}
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          role: {role}
        </p>
      </div>
    </section>
  );
}
