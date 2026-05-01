// Sprint 4 / Chunk 5 — the canonical curated skill set offered as a
// pre-fill on the onboarding wizard's Skills step, keyed by the parent
// level's `orderIndex`.
//
// **Position carries semantic meaning, name does not.** The lookup is by
// the level's `orderIndex` (0..3), not by name — a school operator who
// renamed "Beginner" to "Tadpoles" after applying `ASSA_LEVEL_TEMPLATE`
// still gets the position-1 skills attached. See
// `docs/architecture.md` → "Onboarding templates" for the full rationale.
//
// Positions 0..3 mirror `ASSA_LEVEL_TEMPLATE` exactly:
//   0 — Infants (water familiarisation, breath control)
//   1 — Beginner (face submersion, kicking, floating)
//   2 — Intermediate (strokes, breathing, distance)
//   3 — Advanced (refined strokes, dives, endurance)
//
// **Position 4+ has no template.** A level the operator added beyond the
// four ASSA defaults sits outside the curated mapping; the action layer
// refuses to apply defaults to it (typed `_form` validation error) and
// the UI hides the "Use ASSA defaults" affordance for those levels.
//
// Defined in TypeScript, not the database, because the template is a
// product decision that may evolve between SwimPilot releases independent
// of any tenant's schema. Tenants own their skills once applied.
export const ASSA_SKILL_TEMPLATE: Record<
  0 | 1 | 2 | 3,
  ReadonlyArray<{ name: string; description?: string }>
> = {
  0: [
    {
      name: "Comfort entering water",
      description:
        "Carer holds the child while entering — child is calm and engaged.",
    },
    {
      name: "Splash and play",
      description: "Child splashes hands and feet on cue without distress.",
    },
    {
      name: "Bobs and bubbles",
      description: "Mouth submersion with bubble blowing on cue.",
    },
    {
      name: "Front-hold kick",
      description: "Carer-assisted kicking on front for a count of five.",
    },
    {
      name: "Back-hold float",
      description: "Carer-supported back float; ears in water, eyes up.",
    },
    {
      name: "Reach and grab",
      description: "Reaches for a toy at arm's length while supported.",
    },
  ],
  1: [
    {
      name: "Face submersion",
      description: "Submerges face independently for two seconds on cue.",
    },
    {
      name: "Independent front float",
      description: "Holds a streamlined front float for five seconds.",
    },
    {
      name: "Independent back float",
      description: "Holds a back float for five seconds, ears submerged.",
    },
    {
      name: "Kick on a board (front) 5m",
      description: "Continuous flutter kick across five metres.",
    },
    {
      name: "Streamline push-off",
      description: "Push from the wall in a streamline glide.",
    },
    {
      name: "Pool entry from edge",
      description: "Slide-in entry with a controlled descent.",
    },
    {
      name: "Recover to standing",
      description: "Returns to a stand from a front float.",
    },
  ],
  2: [
    {
      name: "Freestyle 15m",
      description: "Continuous freestyle with side breathing every 3–4 strokes.",
    },
    {
      name: "Backstroke 15m",
      description: "Continuous backstroke; hips up, eyes to ceiling.",
    },
    {
      name: "Bilateral breathing",
      description: "Breathes to both sides over a 25m freestyle effort.",
    },
    {
      name: "Breaststroke 10m",
      description: "Synchronised pull-kick-glide for ten metres.",
    },
    {
      name: "Treading water 30s",
      description: "Holds vertical position with eggbeater or scissor kick.",
    },
    {
      name: "Submerge and retrieve",
      description: "Retrieves an object from chest-deep water.",
    },
  ],
  3: [
    {
      name: "Freestyle 100m on pace",
      description: "Continuous freestyle at a steady, sustainable pace.",
    },
    {
      name: "Backstroke 100m on pace",
      description: "Continuous backstroke at a steady pace; controlled turns.",
    },
    {
      name: "Tumble turn freestyle",
      description: "Tumble turn into and out of the wall on freestyle.",
    },
    {
      name: "Butterfly 25m",
      description: "Continuous butterfly with simultaneous arm recovery.",
    },
    {
      name: "Standing dive",
      description: "Streamlined entry from the pool edge.",
    },
    {
      name: "Endurance swim 200m",
      description: "Choice of stroke; continuous, no rests.",
    },
    {
      name: "Survival sequence 1 minute",
      description: "Tread, signal, and float for sixty seconds.",
    },
  ],
} as const;

export type AssaSkillTemplatePosition = keyof typeof ASSA_SKILL_TEMPLATE;
export type AssaSkillTemplateEntry =
  (typeof ASSA_SKILL_TEMPLATE)[AssaSkillTemplatePosition][number];

// True for the four ASSA-aligned positions; false for any custom level
// the operator added beyond them. Use this to gate UI affordances and
// the action layer.
export function hasAssaSkillTemplate(
  orderIndex: number,
): orderIndex is AssaSkillTemplatePosition {
  return orderIndex === 0 || orderIndex === 1 || orderIndex === 2 || orderIndex === 3;
}
