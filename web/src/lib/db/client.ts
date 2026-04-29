import { PrismaClient } from "@prisma/client";
import { auditExtension } from "./extensions";

// Prefer DATABASE_URL (the restricted `swimpilot_app` role) when it's set
// so RLS is enforced. Fall back to ADMIN_DATABASE_URL for environments
// that haven't provisioned the app role yet — production runs as admin
// in that case, which bypasses RLS. Remove the fallback once the app role
// is configured everywhere.
function resolveRuntimeUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.ADMIN_DATABASE_URL;
  if (!url) {
    throw new Error(
      "Prisma client: DATABASE_URL or ADMIN_DATABASE_URL must be set",
    );
  }
  return url;
}

function createClient() {
  return new PrismaClient({
    datasources: { db: { url: resolveRuntimeUrl() } },
  }).$extends(auditExtension);
}

type ExtendedClient = ReturnType<typeof createClient>;

const globalForPrisma = globalThis as unknown as {
  prisma?: ExtendedClient;
};

export const prisma: ExtendedClient =
  globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
