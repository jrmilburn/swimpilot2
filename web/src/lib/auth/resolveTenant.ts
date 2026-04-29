import { lookupTenant, type Role } from "@/repositories/tenantRepository";
import { ForbiddenError, NotFoundError } from "@/lib/errors";

export type TenantContext = {
  schoolId: string;
  schoolName: string;
  role: Role;
};

/**
 * Resolve `(schoolSlug, userId)` to a `TenantContext`.
 *
 * - Throws `NotFoundError` if no active school has the given slug.
 * - Throws `ForbiddenError` if the school exists but the user has no
 *   active membership.
 *
 * The actual SQL lookup runs through `lookupTenant`, which calls the
 * `app_resolve_tenant` SECURITY DEFINER function. The function bypasses
 * RLS for this one privileged read because the caller is not yet scoped
 * to any school — that's what this resolver decides. See
 * `docs/security.md` for the full justification.
 */
export async function resolveTenant(
  schoolSlug: string,
  userId: string,
): Promise<TenantContext> {
  const result = await lookupTenant(schoolSlug, userId);

  switch (result.kind) {
    case "not_found":
      throw new NotFoundError(`School not found: ${schoolSlug}`);
    case "no_membership":
      throw new ForbiddenError(
        `User ${userId} has no membership in ${schoolSlug}`,
      );
    case "ok":
      return {
        schoolId: result.schoolId,
        schoolName: result.schoolName,
        role: result.role,
      };
  }
}
