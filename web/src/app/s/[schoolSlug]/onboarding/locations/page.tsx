import { requireTenant } from "@/lib/auth/requireTenant";
import { withTenant } from "@/lib/db/withTenant";
import * as locationRepository from "@/repositories/locationRepository";
import * as schoolRepository from "@/repositories/schoolRepository";
import { LocationsList } from "./_components/LocationsList";

// Sprint 4 / Chunk 3 — the Locations step body. The page reads the
// school's locations inside `withTenant` so RLS scopes the lookup, then
// hands them to a client component along with the school timezone (used
// as the placeholder when the operator leaves a per-location timezone
// blank).
export default async function LocationsStepPage({
  params,
}: {
  params: Promise<{ schoolSlug: string }>;
}) {
  const { schoolSlug } = await params;
  const { schoolId, userId } = await requireTenant(schoolSlug);

  const [school, locations] = await withTenant(
    { schoolId, userId },
    async (tx) => {
      const [s, ls] = await Promise.all([
        schoolRepository.getById(tx, schoolId),
        locationRepository.listBySchool(tx),
      ]);
      return [s, ls] as const;
    },
  );
  if (!school) {
    throw new Error(`schoolRepository.getById returned null for ${schoolId}`);
  }

  return (
    <section className="flex flex-1 flex-col items-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h2 className="text-xl font-semibold tracking-tight">
            Where do you teach?
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Add one row for each pool or venue you run classes from. You can
            edit or remove these later. At least one is required to keep
            going — locations are how classes know where to be scheduled.
          </p>
        </header>
        <LocationsList
          initial={locations}
          schoolSlug={schoolSlug}
          schoolTimezone={school.timezone}
        />
      </div>
    </section>
  );
}
