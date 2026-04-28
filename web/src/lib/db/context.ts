import { AsyncLocalStorage } from "node:async_hooks";

export const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

type DbContext = { actorId: string };

const storage = new AsyncLocalStorage<DbContext>();

export function runWithActor<T>(actorId: string, fn: () => T): T {
  return storage.run({ actorId }, fn);
}

export function getActorId(): string {
  return storage.getStore()?.actorId ?? SYSTEM_USER_ID;
}
