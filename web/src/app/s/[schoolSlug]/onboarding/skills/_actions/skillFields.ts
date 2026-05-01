import { z } from "zod";

// Shared zod field schemas for the per-row skill actions. Mirrors
// `levelFields.ts` from Chunk 4 — the action layer parses with these,
// builds a `fieldErrors` map from zod issues, and `tenantAction` carries
// the typed payload through to the form.
//
// `orderIndex` is intentionally absent from the create / update schemas.
// The server normalises positions to `0..n-1` (append on add, compact on
// archive, explicit `reorderSkills` for moves) and never trusts a
// client-supplied index.
//
// `levelId` is in `CreateSkillSchema` (the action needs to know which
// accordion section the skill belongs to) but **not** in
// `UpdateSkillSchema` — a skill stays in the level it was created under.
// To "move" between levels, archive and recreate. The repository's
// `update` doesn't expose `levelId` either, defending in depth.

export const SkillNameField = z
  .string({ message: "Name is required" })
  .trim()
  .min(1, "Name is required")
  .max(100, "Name is too long");

// Plain text — no rich text, no markdown, no HTML. Spec says "no rich
// text this sprint." Rendered in a multi-line `<textarea>` and displayed
// wrapped in a `<p>` tag.
export const SkillDescriptionField = z
  .string()
  .trim()
  .max(1000, "Description is too long")
  .nullable();

export const CreateSkillSchema = z.object({
  levelId: z.uuid("Invalid level id"),
  name: SkillNameField,
  description: SkillDescriptionField.optional().default(null),
});

export const UpdateSkillSchema = z.object({
  name: SkillNameField.optional(),
  description: SkillDescriptionField.optional(),
});

export type CreateSkillFormInput = z.infer<typeof CreateSkillSchema>;
export type UpdateSkillFormInput = z.infer<typeof UpdateSkillSchema>;
