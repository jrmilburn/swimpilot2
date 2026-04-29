import { PrismaClient } from "@/generated/prisma/client";
import { auditExtension } from "./extensions";

function createClient() {
  return new PrismaClient().$extends(auditExtension);
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
