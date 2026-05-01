import { Role } from "@prisma/client";
import { prisma } from "../lib/db/client";
import { OnboardingStep } from "../domain/enums";

// Re-export Role so callers outside the repository layer can use the
// domain role enum without violating the no-restricted-imports rule that
// forbids reaching directly into @prisma/client.
export { Role };

export type TenantLookup =
  | { kind: "not_found" }
  | { kind: "no_membership"; schoolId: string; schoolName: string }
  | { kind: "ok"; schoolId: string; schoolName: string; role: Role };

export type UserMembership = {
  schoolId: string;
  slug: string;
  schoolName: string;
  role: Role;
};

type Row = {
  school_id: string;
  school_name: string;
  role: Role | null;
};

type MembershipRow = {
  school_id: string;
  slug: string;
  name: string;
  role: Role;
};

/**
 * Look up the tenant context for `(slug, userId)` BEFORE we know which
 * school the caller belongs to.
 *
 * Delegates to the `app_resolve_tenant(text, uuid)` SECURITY DEFINER
 * function in Postgres. That function bypasses RLS on `schools` and
 * `memberships` (it has to — the caller has no `app.school_id` set yet)
 * but the surface area is narrow: it only returns `(school_id, role)` for
 * the specific (slug, user) pair. See `docs/security.md` for the full
 * reasoning behind this seam.
 *
 * Three states are returned, mirroring the function's own three cases:
 *   - 0 rows                         → `not_found` (school doesn't exist
 *                                       or is soft-deleted)
 *   - 1 row, role IS NULL            → `no_membership` (school exists,
 *                                       caller is not an active member)
 *   - 1 row, role IS NOT NULL        → `ok`
 */
export async function lookupTenant(
  slug: string,
  userId: string,
): Promise<TenantLookup> {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT school_id, school_name, role
    FROM app_resolve_tenant(${slug}, ${userId}::uuid)
  `;

  if (rows.length === 0) return { kind: "not_found" };
  const row = rows[0]!;
  if (row.role === null) {
    return {
      kind: "no_membership",
      schoolId: row.school_id,
      schoolName: row.school_name,
    };
  }
  return {
    kind: "ok",
    schoolId: row.school_id,
    schoolName: row.school_name,
    role: row.role,
  };
}

/**
 * List every active membership for `userId`, including the school's slug
 * and display name. Used by the post-sign-in landing page to dispatch on
 * 0 / 1 / many memberships before any tenant context is established.
 *
 * Like `lookupTenant`, this delegates to a SECURITY DEFINER function so
 * it can read schools/memberships without the caller having
 * `app.school_id` set.
 */
export async function listUserMemberships(
  userId: string,
): Promise<UserMembership[]> {
  const rows = await prisma.$queryRaw<MembershipRow[]>`
    SELECT school_id, slug, name, role
    FROM app_list_user_memberships(${userId}::uuid)
  `;

  return rows.map((r) => ({
    schoolId: r.school_id,
    slug: r.slug,
    schoolName: r.name,
    role: r.role,
  }));
}

export type OnboardingRedirectState = {
  currentStep: OnboardingStep;
  completedAt: Date | null;
};

type OnboardingStateRow = {
  current_step: OnboardingStep;
  completed_at: Date | null;
};

/**
 * Read just enough of `onboarding_progress` to drive the / landing
 * page's redirect: the school's current wizard step and whether the
 * wizard has been completed.
 *
 * Same chicken-and-egg as `lookupTenant`: the / landing page resolves
 * the user's primary school slug, then needs to know whether that
 * school is mid-wizard, all BEFORE any tenant context is open. RLS
 * would return zero rows on a direct read; we go through the narrow
 * `app_get_onboarding_state(uuid)` SECURITY DEFINER function instead.
 *
 * Returns `null` if no row exists for that school. Callers treat that
 * as "no redirect target" — in practice the AFTER INSERT trigger on
 * `schools` ensures every school has a row, so seeing null here is a
 * trigger-misfire signal.
 */
export async function getOnboardingRedirectState(
  schoolId: string,
): Promise<OnboardingRedirectState | null> {
  const rows = await prisma.$queryRaw<OnboardingStateRow[]>`
    SELECT current_step, completed_at
    FROM app_get_onboarding_state(${schoolId}::uuid)
  `;
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    currentStep: row.current_step,
    completedAt: row.completed_at,
  };
}
