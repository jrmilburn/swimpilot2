// Sprint 4 / Chunk 4 — the canonical four-level framework offered as a
// pre-fill on the onboarding wizard's Levels step.
//
// **Position carries semantic meaning.** Chunk 5 attaches the ASSA skill
// template to the level by `orderIndex`, not by name — the operator can
// rename "Beginner" to "Tadpoles" after applying this template and the
// skill attachment still works. Do not reorder this array without
// updating Chunk 5's skill template (when it lands).
//
// Defined in TypeScript, not the database, because the template is a
// product decision that may evolve between SwimPilot releases independent
// of any tenant's schema. Tenants own their levels once applied.
export const ASSA_LEVEL_TEMPLATE = [
  {
    name: "Infants",
    ratio: 4,
    defaultProgressionThreshold: 80,
    minAgeMonths: 6,
    maxAgeMonths: 36,
  },
  {
    name: "Beginner",
    ratio: 6,
    defaultProgressionThreshold: 80,
    minAgeMonths: 36,
    maxAgeMonths: 72,
  },
  {
    name: "Intermediate",
    ratio: 8,
    defaultProgressionThreshold: 80,
    minAgeMonths: 60,
    maxAgeMonths: 120,
  },
  {
    name: "Advanced",
    ratio: 8,
    defaultProgressionThreshold: 80,
    minAgeMonths: 96,
    maxAgeMonths: null,
  },
] as const;

export type AssaLevelTemplateEntry = (typeof ASSA_LEVEL_TEMPLATE)[number];
