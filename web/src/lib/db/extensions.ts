import { Prisma } from "@prisma/client";
import { getActorId } from "./context";

const DOMAIN_MODELS = new Set<string>([
  "School",
  "User",
  "Membership",
  "Location",
  "Family",
  "Student",
  "ClassLevel",
  "Class",
  "Enrolment",
  "ClassSession",
  "Attendance",
  "Skill",
  "StudentSkill",
  "BillingProfile",
  "Invoice",
  "InvoiceLine",
  "Credit",
  "AiCall",
  "OnboardingProgress",
  "PendingInvitation",
]);

const WRITE_OPS = new Set<string>([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);

type AnyData = Record<string, unknown>;

function withCreateAudit(data: AnyData, actorId: string): AnyData {
  return {
    ...data,
    createdBy: data.createdBy ?? actorId,
    updatedBy: data.updatedBy ?? actorId,
  };
}

function withUpdateAudit(data: AnyData, actorId: string): AnyData {
  return {
    ...data,
    updatedBy: data.updatedBy ?? actorId,
  };
}

export const auditExtension = Prisma.defineExtension({
  name: "audit-fields",
  query: {
    $allModels: {
      async $allOperations({
        model,
        operation,
        args,
        query,
      }: {
        model?: string;
        operation: string;
        args: unknown;
        query: (args: unknown) => Promise<unknown>;
      }) {
        if (!model || !DOMAIN_MODELS.has(model) || !WRITE_OPS.has(operation)) {
          return query(args);
        }

        const actorId = getActorId();
        const a = args as AnyData;

        switch (operation) {
          case "create": {
            a.data = withCreateAudit(a.data as AnyData, actorId);
            break;
          }
          case "createMany":
          case "createManyAndReturn": {
            const d = a.data;
            a.data = Array.isArray(d)
              ? d.map((row) => withCreateAudit(row as AnyData, actorId))
              : withCreateAudit(d as AnyData, actorId);
            break;
          }
          case "update":
          case "updateMany":
          case "updateManyAndReturn": {
            a.data = withUpdateAudit(a.data as AnyData, actorId);
            break;
          }
          case "upsert": {
            a.create = withCreateAudit(a.create as AnyData, actorId);
            a.update = withUpdateAudit(a.update as AnyData, actorId);
            break;
          }
        }

        return query(args);
      },
    },
  },
});
