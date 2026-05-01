import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { requireTenant } from "./requireTenant";
import { withTenant, type TenantTx } from "@/lib/db/withTenant";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { type Role } from "@/repositories/tenantRepository";

export type TenantContext = {
  userId: string;
  schoolId: string;
  role: Role;
  tx: TenantTx;
};

export type ActionError = {
  code: "NOT_FOUND" | "FORBIDDEN" | "VALIDATION" | "INTERNAL";
  message: string;
  // Set when a `ValidationError` carried per-field error messages. Form
  // bridges read this in preference to substring-matching on `message`.
  // Only present on `code: 'VALIDATION'` results.
  fieldErrors?: Record<string, string>;
};

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ActionError };

/**
 * Wrap a tenant-scoped server action.
 *
 * Every server action under `/s/[schoolSlug]/` must go through this
 * wrapper. It is the single seam between "I'm a server action" and
 * "I'm a tenant-scoped DB operation": it resolves the tenant, opens an
 * RLS-scoped transaction, and turns typed domain errors into a structured
 * `ActionResult` the client can read without try/catch.
 *
 * Result-object convention (vs. throwing): server actions returning
 * `{ ok, data | error }` integrate cleanly with `useActionState` and
 * spare every form from wrapping its action call in try/catch. Next.js
 * control-flow errors (`redirect`, `notFound`, `forbidden`) are still
 * re-thrown via `unstable_rethrow` so the framework can handle them.
 *
 * Slug discovery: the tenant slug is read from the trusted `x-school-slug`
 * request header set by `middleware.ts` for any `/s/[slug]/...` URL. We
 * deliberately do NOT take a slug argument — passing one through the
 * action body would let the client smuggle a slug they don't own. RLS
 * would still block the data, but failing earlier at routing is cleaner.
 *
 * Future hooks for this wrapper: structured logging, request metrics,
 * per-action rate limiting, role-based authorisation policies.
 */
export function tenantAction<TArgs extends unknown[], TResult>(
  fn: (ctx: TenantContext, ...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<ActionResult<TResult>> {
  return async (...args: TArgs): Promise<ActionResult<TResult>> => {
    const slug = await readSlugFromRequest();
    const tenant = await requireTenant(slug);

    try {
      const data = await withTenant(
        { schoolId: tenant.schoolId, userId: tenant.userId },
        (tx) =>
          fn(
            {
              userId: tenant.userId,
              schoolId: tenant.schoolId,
              role: tenant.role,
              tx,
            },
            ...args,
          ),
      );
      return { ok: true, data };
    } catch (err) {
      // Next.js uses thrown errors for control flow (redirect / notFound /
      // forbidden / unauthorized). Those MUST propagate so the framework
      // can handle them — never collapse them into an ActionResult.
      // `unstable_rethrow` is the documented Next 16 helper for this;
      // older `isRedirectError` / `isNotFoundError` predicates are no
      // longer exported from `next/navigation`.
      unstable_rethrow(err);

      if (err instanceof NotFoundError) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: err.message },
        };
      }
      if (err instanceof ForbiddenError) {
        return {
          ok: false,
          error: { code: "FORBIDDEN", message: err.message },
        };
      }
      if (err instanceof ValidationError) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: err.message,
            ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {}),
          },
        };
      }

      // Unknown failure: log full stack server-side, return a generic
      // message to the client. Never leak internal messages — they can
      // contain DB column names, query fragments, etc.
      console.error("[tenantAction] unhandled error", err);
      return {
        ok: false,
        error: { code: "INTERNAL", message: "Something went wrong" },
      };
    }
  };
}

async function readSlugFromRequest(): Promise<string> {
  const slug = (await headers()).get("x-school-slug");
  if (!slug) {
    throw new Error(
      "tenantAction: no x-school-slug header. " +
        "This wrapper must be used from a server action under /s/[schoolSlug]/. " +
        "If you are seeing this in tests, set the header in your test request.",
    );
  }
  return slug;
}
