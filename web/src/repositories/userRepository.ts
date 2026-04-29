import { prisma } from "../lib/db/client";

export type User = {
  id: string;
  clerkId: string | null;
  email: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
  deletedAt: Date | null;
};

export type UpsertFromClerkInput = {
  clerkId: string;
  email: string;
  name: string;
};

type UserRow = {
  id: string;
  clerk_id: string | null;
  email: string;
  name: string;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
};

function toUser(row: UserRow): User {
  return {
    id: row.id,
    clerkId: row.clerk_id,
    email: row.email,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    deletedAt: row.deleted_at,
  };
}

// Raw SQL upsert: bypasses the audit-fields Prisma extension so created_by /
// updated_by stay NULL. Clerk is the actor here, not a tenant user, and the
// `users` table tolerates null audit fields specifically for this case.
export async function upsertFromClerk(input: UpsertFromClerkInput): Promise<User> {
  const rows = await prisma.$queryRaw<UserRow[]>`
    INSERT INTO users (clerk_id, email, name, updated_at)
    VALUES (${input.clerkId}, ${input.email}, ${input.name}, now())
    ON CONFLICT (clerk_id) DO UPDATE
      SET email = EXCLUDED.email,
          name = EXCLUDED.name,
          updated_at = now()
    RETURNING id, clerk_id, email, name, created_at, updated_at, created_by, updated_by, deleted_at
  `;

  const row = rows[0];
  if (!row) {
    throw new Error("upsertFromClerk: no row returned");
  }
  return toUser(row);
}
