// Pure date-expansion logic for enrolments. No DB access, no `now()`, no
// I/O — every input is a parameter so the function is fully unit-testable
// and time-travel-safe in tests.
//
// Calendar dates throughout this module are JS `Date` values anchored at
// UTC midnight (matching how the repository maps Postgres `date`). All
// arithmetic is done on UTC components — never local time — so daylight
// savings transitions can't shift the day-of-week alignment.

import type { Enrolment } from "./types";
import { EnrolmentFrequency, WeekDay } from "./enums";

const MS_PER_DAY = 86_400_000;

const WEEKDAY_INDEX: Record<WeekDay, number> = {
  // JS getUTCDay: Sunday = 0, Monday = 1, …, Saturday = 6.
  [WeekDay.Sunday]: 0,
  [WeekDay.Monday]: 1,
  [WeekDay.Tuesday]: 2,
  [WeekDay.Wednesday]: 3,
  [WeekDay.Thursday]: 4,
  [WeekDay.Friday]: 5,
  [WeekDay.Saturday]: 6,
};

function utcMidnight(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

function diffDays(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / MS_PER_DAY);
}

export function expandEnrolmentDates(
  enrolment: Pick<
    Enrolment,
    "frequency" | "startDate" | "endDate" | "pauseFrom" | "pauseTo"
  >,
  classDayOfWeek: WeekDay,
  range: { from: Date; to: Date },
): Date[] {
  const targetDow = WEEKDAY_INDEX[classDayOfWeek];
  const from = utcMidnight(range.from);
  const to = utcMidnight(range.to);
  if (from.getTime() > to.getTime()) return [];

  const start = utcMidnight(enrolment.startDate);
  const end = enrolment.endDate ? utcMidnight(enrolment.endDate) : null;
  const pauseFrom = enrolment.pauseFrom ? utcMidnight(enrolment.pauseFrom) : null;
  const pauseTo = enrolment.pauseTo ? utcMidnight(enrolment.pauseTo) : null;

  // One-off short-circuit: only `startDate` is ever a candidate.
  if (enrolment.frequency === EnrolmentFrequency.OneOff) {
    if (start.getUTCDay() !== targetDow) return [];
    if (start.getTime() < from.getTime() || start.getTime() > to.getTime()) {
      return [];
    }
    if (
      pauseFrom &&
      pauseTo &&
      start.getTime() >= pauseFrom.getTime() &&
      start.getTime() <= pauseTo.getTime()
    ) {
      return [];
    }
    return [start];
  }

  // Walk to the first occurrence of `classDayOfWeek` on or after the
  // greater of `from` and `start`. Stepping by 7 days from there covers
  // every candidate without per-day iteration.
  const lower =
    from.getTime() >= start.getTime() ? from : start;
  const offsetToDow = (targetDow - lower.getUTCDay() + 7) % 7;
  let cursor = new Date(lower.getTime() + offsetToDow * MS_PER_DAY);

  const upper = end && end.getTime() < to.getTime() ? end : to;

  const results: Date[] = [];
  while (cursor.getTime() <= upper.getTime()) {
    let qualifies = true;
    if (
      enrolment.frequency === EnrolmentFrequency.FortnightlyA ||
      enrolment.frequency === EnrolmentFrequency.FortnightlyB
    ) {
      // Anchor on the enrolment's startDate. The week parity of `cursor`
      // relative to `start` decides which fortnight bucket it lands in.
      const weeksFromStart = Math.floor(diffDays(cursor, start) / 7);
      const isEvenWeek = weeksFromStart % 2 === 0;
      qualifies =
        enrolment.frequency === EnrolmentFrequency.FortnightlyA
          ? isEvenWeek
          : !isEvenWeek;
    }

    if (
      qualifies &&
      pauseFrom &&
      pauseTo &&
      cursor.getTime() >= pauseFrom.getTime() &&
      cursor.getTime() <= pauseTo.getTime()
    ) {
      qualifies = false;
    }

    if (qualifies) results.push(cursor);
    cursor = new Date(cursor.getTime() + 7 * MS_PER_DAY);
  }

  return results;
}
