import Link from "next/link";
import { SignOutButton } from "@clerk/nextjs";
import { requireTenant } from "@/lib/auth/requireTenant";
import { SchoolSwitcher } from "./_components/SchoolSwitcher";

export default async function TenantLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ schoolSlug: string }>;
}) {
  const { schoolSlug } = await params;
  // requireTenant() is wrapped in React.cache() so this work is shared
  // with whatever page is rendered below us — only one DB lookup per
  // request, even though the layout and the page both call it.
  const { userId, schoolName, role } = await requireTenant(schoolSlug);

  return (
    <div className="flex min-h-full flex-col bg-zinc-50 font-sans dark:bg-black">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center gap-4">
          <Link href={`/s/${schoolSlug}`} className="text-lg font-semibold">
            {schoolName}
          </Link>
          <span className="text-xs uppercase tracking-wide text-zinc-500">
            {role}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <SchoolSwitcher currentSlug={schoolSlug} userId={userId} />
          <SignOutButton>
            <button className="rounded-full border px-3 py-1.5 text-sm">
              Sign out
            </button>
          </SignOutButton>
        </div>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
