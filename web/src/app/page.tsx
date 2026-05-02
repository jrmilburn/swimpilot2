import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";
import { SignOutButton } from "@clerk/nextjs";
import {
  getByClerkId,
  upsertFromClerk,
  type User,
} from "@/repositories/userRepository";
import {
  getOnboardingRedirectState,
  listUserMemberships,
  type UserMembership,
} from "@/repositories/tenantRepository";
import { resolveAcceptedInvitation } from "@/lib/auth/resolveAcceptedInvitation";

const LAST_SCHOOL_COOKIE = "swp_last_school";

export default async function Home() {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) {
    return <SignedOutLanding />;
  }

  const dbUser = await resolveDbUser(clerkUserId);

  // Sign-in-redirect path: if this user has any still-pending Clerk
  // invitations matching their email, finalise them before listing
  // memberships. Idempotent — a second pass after acceptance no-ops.
  // Failures are caught per-invitation inside the helper so a single
  // bad row can't block sign-in.
  await resolveAcceptedInvitation(dbUser.id, dbUser.email);

  const memberships = await listUserMemberships(dbUser.id);

  if (memberships.length === 0) {
    return <NoSchoolsYet email={dbUser.email} />;
  }
  if (memberships.length === 1) {
    await redirectToSchool(memberships[0]!);
  }

  // Multi-membership: if the user has a last-school cookie pointing at a
  // school they're still a member of, skip the picker. The cookie is a UX
  // hint only — confirm the slug against actual memberships before trusting
  // it, so a stale cookie can't redirect into a school the user no longer
  // belongs to.
  const cookieStore = await cookies();
  const lastSlug = cookieStore.get(LAST_SCHOOL_COOKIE)?.value;
  if (lastSlug) {
    const match = memberships.find((m) => m.slug === lastSlug);
    if (match) {
      await redirectToSchool(match);
    }
  }

  return <SchoolPicker memberships={memberships} email={dbUser.email} />;
}

// Redirect a user into the right entry-point for their school. Schools
// whose `onboarding_progress.completed_at` is null go to the wizard at
// `/s/<slug>/onboarding/<currentStep>`; complete schools go to the
// dashboard at `/s/<slug>`. The redirect state is read via the
// SECURITY DEFINER `app_get_onboarding_state` function before any
// tenant context is open — same seam as `app_resolve_tenant`.
//
// If the onboarding row is missing (the AFTER INSERT trigger should make
// that impossible), default to the dashboard rather than throwing — the /
// landing page is the wrong place to surface that bug, and falling
// through to the dashboard means existing users still get somewhere
// useful while we investigate.
async function redirectToSchool(membership: UserMembership): Promise<never> {
  const state = await getOnboardingRedirectState(membership.schoolId);
  if (state && state.completedAt === null) {
    redirect(`/s/${membership.slug}/onboarding/${state.currentStep}`);
  }
  redirect(`/s/${membership.slug}`);
}

async function resolveDbUser(clerkUserId: string): Promise<User> {
  // Same inline-sync pattern as requireTenant(): if the Clerk webhook
  // hasn't synced yet, upsert from currentUser() ourselves. Idempotent
  // under (clerk_id), so a webhook arriving later is a no-op.
  const existing = await getByClerkId(clerkUserId);
  if (existing) return existing;

  const profile = await currentUser();
  if (!profile) redirect("/sign-in");

  const email =
    profile.primaryEmailAddress?.emailAddress ??
    profile.emailAddresses[0]?.emailAddress;
  if (!email) {
    throw new Error(
      `Clerk user ${clerkUserId} has no email address; cannot sync.`,
    );
  }
  const name =
    [profile.firstName, profile.lastName]
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .join(" ") ||
    profile.username ||
    "";

  return upsertFromClerk({ clerkId: clerkUserId, email, name });
}

function SignedOutLanding() {
  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex flex-col items-center gap-6 p-8">
        <h1 className="text-2xl font-semibold tracking-tight">SwimPilot</h1>
        <Link
          href="/sign-in"
          className="rounded-full bg-foreground px-5 py-2 text-background"
        >
          Sign in
        </Link>
      </main>
    </div>
  );
}

function NoSchoolsYet({ email }: { email: string }) {
  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex max-w-md flex-col items-center gap-6 p-8 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          No schools yet
        </h1>
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          Signed in as {email}. You haven&apos;t been added to a school yet.
          Ask your school owner to invite you, or create a new school once
          school creation is wired up.
        </p>
        <SignOutButton>
          <button className="rounded-full border px-4 py-2 text-sm">
            Sign out
          </button>
        </SignOutButton>
      </main>
    </div>
  );
}

function SchoolPicker({
  memberships,
  email,
}: {
  memberships: { slug: string; schoolName: string; role: string }[];
  email: string;
}) {
  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-md flex-col gap-6 p-8">
        <header className="flex flex-col gap-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Choose a school
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Signed in as {email}
          </p>
        </header>
        <ul className="flex flex-col gap-2">
          {memberships.map((m) => (
            <li key={m.slug}>
              <Link
                href={`/s/${m.slug}`}
                className="block rounded-lg border border-zinc-200 p-4 transition hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
              >
                <div className="font-medium">{m.schoolName}</div>
                <div className="text-xs uppercase tracking-wide text-zinc-500">
                  {m.role}
                </div>
              </Link>
            </li>
          ))}
        </ul>
        <div className="self-center">
          <SignOutButton>
            <button className="rounded-full border px-4 py-2 text-sm">
              Sign out
            </button>
          </SignOutButton>
        </div>
      </main>
    </div>
  );
}
