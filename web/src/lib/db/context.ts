import { AsyncLocalStorage } from "node:async_hooks";

export const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

type DbContext = {
  actorId: string;
  schoolId?: string;
};

const storage = new AsyncLocalStorage<DbContext>();

export function runWithActor<T>(actorId: string, fn: () => T): T {
  return storage.run({ actorId }, fn);
}

export function runWithTenant<T>(
  ctx: { actorId: string; schoolId: string },
  fn: () => T,
): T {
  return storage.run(ctx, fn);
}

/**
 * Set the actor for the rest of the current async chain.
 *
 * Used by `requireTenant()` (a server-component helper) which can't wrap
 * its caller in a callback the way `withTenant` does. `enterWith` binds
 * the store to *this* async context onwards, so descendants in the same
 * request render see the actor when the audit-fields extension calls
 * `getActorId()`.
 *
 * Each Next.js render runs in its own async context root, so this won't
 * leak across requests.
 */
export function setRequestActor(actorId: string, schoolId?: string): void {
  storage.enterWith({ actorId, schoolId });
}

export function getActorId(): string {
  return storage.getStore()?.actorId ?? SYSTEM_USER_ID;
}

export function getSchoolId(): string | undefined {
  return storage.getStore()?.schoolId;
}
