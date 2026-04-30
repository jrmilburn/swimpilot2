import Link from "next/link";
import { listUserMemberships } from "@/repositories/tenantRepository";

export async function SchoolSwitcher({
  currentSlug,
  userId,
}: {
  currentSlug: string;
  userId: string;
}) {
  const memberships = await listUserMemberships(userId);
  const current = memberships.find((m) => m.slug === currentSlug);
  const others = memberships.filter((m) => m.slug !== currentSlug);

  if (others.length === 0) {
    return null;
  }

  const label = current?.schoolName ?? "Switch school";

  return (
    <details className="group relative">
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900">
        <span>{label}</span>
        <span aria-hidden className="text-xs">▾</span>
      </summary>
      <div className="absolute right-0 top-full z-10 mt-1 w-64 rounded-lg border border-zinc-200 bg-white p-1 shadow-md dark:border-zinc-800 dark:bg-zinc-950">
        <ul className="flex flex-col">
          {others.map((m) => (
            <li key={m.slug}>
              <Link
                href={`/s/${m.slug}`}
                className="flex flex-col rounded-md px-3 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-900"
              >
                <span className="text-sm font-medium">{m.schoolName}</span>
                <span className="text-xs uppercase tracking-wide text-zinc-500">
                  {m.role}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
