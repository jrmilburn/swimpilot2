import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";
import { type Role } from "@/repositories/tenantRepository";
import { resolveTenant } from "./resolveTenant";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { setRequestActor } from "@/lib/db/context";
import {
  getByClerkId,
  upsertFromClerk,
  type User,
} from "@/repositories/userRepository";

export type RequiredTenant = {
  userId: string;
  schoolId: string;
  schoolName: string;
  role: Role;
};

/**
 * Tenant-resolution decisions for routes under `/s/[schoolSlug]/`.
 *
 * - Unauthenticated → redirect to `/sign-in` (Clerk middleware also
 *   enforces this; this is a defence-in-depth fallback).
 * - Authenticated but no DB user yet (Clerk webhook hasn't fired or is
 *   delayed) → run `upsertFromClerk` inline from the Clerk profile we
 *   already have. This is idempotent (ON CONFLICT (clerk_id) DO UPDATE)
 *   so a webhook arriving moments later is a no-op.
 * - School slug doesn't exist → `notFound()` (404).
 * - User exists but has no membership in the requested school → also
 *   `notFound()` (404). We collapse 403 into 404 to avoid leaking the
 *   set of school slugs to anyone who is signed in. See
 *   `docs/security.md` for the rationale.
 *
 * Wrapped in React `cache()` so calling it multiple times in the same
 * request render — e.g. once in a layout and again in a child page —
 * hits the DB only once.
 */
async function requireTenantUncached(
  schoolSlug: string,
): Promise<RequiredTenant> {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) {
    redirect("/sign-in");
  }

  const dbUser = await resolveDbUser(clerkUserId);

  try {
    const { schoolId, schoolName, role } = await resolveTenant(
      schoolSlug,
      dbUser.id,
    );
    setRequestActor(dbUser.id, schoolId);
    return { userId: dbUser.id, schoolId, schoolName, role };
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ForbiddenError) {
      // Both collapse to 404. notFound() throws — `never` return type.
      notFound();
    }
    throw err;
  }
}

async function resolveDbUser(clerkUserId: string): Promise<User> {
  const existing = await getByClerkId(clerkUserId);
  if (existing) return existing;

  // Inline sync: the webhook hasn't synced this user yet (or hasn't been
  // configured in this environment). Read the Clerk profile and upsert.
  // Idempotent under (clerk_id) so a webhook landing later is a no-op.
  const clerkProfile = await currentUser();
  if (!clerkProfile) {
    // auth() said we're signed in, but currentUser() returned nothing.
    // Treat as unauthenticated rather than papering over with a fake user.
    redirect("/sign-in");
  }

  const email =
    clerkProfile.primaryEmailAddress?.emailAddress ??
    clerkProfile.emailAddresses[0]?.emailAddress;
  if (!email) {
    throw new Error(
      `Clerk user ${clerkUserId} has no email address; cannot sync.`,
    );
  }

  const name =
    [clerkProfile.firstName, clerkProfile.lastName]
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .join(" ") ||
    clerkProfile.username ||
    "";

  return upsertFromClerk({ clerkId: clerkUserId, email, name });
}

export const requireTenant = cache(requireTenantUncached);
