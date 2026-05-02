"use server";

import { z } from "zod";
import { tenantAction } from "@/lib/auth/tenantAction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import * as importRepository from "@/repositories/importRepository";

const Input = z.object({
  batchId: z.string().uuid(),
});

export type RollbackImportResult = {
  rolledBack: true;
  alreadyRolledBack: boolean;
};

export const rollbackImportAction = tenantAction(
  async ({ tx }, input: unknown): Promise<RollbackImportResult> => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? "Invalid input",
      );
    }

    // Cross-tenant pre-check: RLS hides batches that don't belong to
    // this school, so a missing row here means either it never existed
    // or it belongs to another tenant. Either way: 404.
    const batch = await importRepository.getById(tx, parsed.data.batchId);
    if (!batch) {
      throw new NotFoundError("Import batch not found");
    }

    const result = await importRepository.rollbackImport(tx, parsed.data.batchId);
    return { rolledBack: true, alreadyRolledBack: result.alreadyRolledBack };
  },
);
