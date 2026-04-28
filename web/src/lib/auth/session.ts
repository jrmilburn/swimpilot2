import { headers } from "next/headers";

export type Session = {
  userId: string;
  schoolId: string;
};

/**
 * Resolve the caller's session.
 *
 * TODO(auth): replace this with the real session resolver (likely a signed
 * cookie). For now we read `x-user-id` and `x-school-id` directly so the
 * tenant-context plumbing can be exercised end-to-end before auth lands.
 */
export async function resolveSession(): Promise<Session> {
  const h = await headers();
  const userId = h.get("x-user-id");
  const schoolId = h.get("x-school-id");

  if (!userId || !schoolId) {
    throw new Error(
      "Unauthorized: missing x-user-id or x-school-id (auth stub)",
    );
  }

  return { userId, schoolId };
}
