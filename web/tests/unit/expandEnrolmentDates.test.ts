import { describe, expect, test } from "vitest";
import { expandEnrolmentDates } from "../../src/domain/enrolment";
import { EnrolmentFrequency, WeekDay } from "../../src/domain/enums";

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);

// 2026-04-01 is a Wednesday — used as the canonical anchor across cases.
const APR_1 = d("2026-04-01");
const APR_8 = d("2026-04-08");
const APR_15 = d("2026-04-15");
const APR_22 = d("2026-04-22");
const APR_29 = d("2026-04-29");

describe("expandEnrolmentDates", () => {
  test("weekly enrolment returns every matching weekday in range", () => {
    const dates = expandEnrolmentDates(
      {
        frequency: EnrolmentFrequency.Weekly,
        startDate: APR_1,
        endDate: null,
        pauseFrom: null,
        pauseTo: null,
      },
      WeekDay.Wednesday,
      { from: APR_1, to: APR_29 },
    );
    expect(dates.map(iso)).toEqual([
      "2026-04-01",
      "2026-04-08",
      "2026-04-15",
      "2026-04-22",
      "2026-04-29",
    ]);
  });

  test("fortnightly_a includes start week and skips alternate weeks", () => {
    const dates = expandEnrolmentDates(
      {
        frequency: EnrolmentFrequency.FortnightlyA,
        startDate: APR_1,
        endDate: null,
        pauseFrom: null,
        pauseTo: null,
      },
      WeekDay.Wednesday,
      { from: APR_1, to: APR_29 },
    );
    expect(dates.map(iso)).toEqual([
      "2026-04-01",
      "2026-04-15",
      "2026-04-29",
    ]);
  });

  test("fortnightly_b skips start week and includes alternate weeks", () => {
    const dates = expandEnrolmentDates(
      {
        frequency: EnrolmentFrequency.FortnightlyB,
        startDate: APR_1,
        endDate: null,
        pauseFrom: null,
        pauseTo: null,
      },
      WeekDay.Wednesday,
      { from: APR_1, to: APR_29 },
    );
    expect(dates.map(iso)).toEqual(["2026-04-08", "2026-04-22"]);
  });

  test("one_off matching the day returns only startDate", () => {
    const dates = expandEnrolmentDates(
      {
        frequency: EnrolmentFrequency.OneOff,
        startDate: APR_15,
        endDate: APR_15,
        pauseFrom: null,
        pauseTo: null,
      },
      WeekDay.Wednesday,
      { from: APR_1, to: APR_29 },
    );
    expect(dates.map(iso)).toEqual(["2026-04-15"]);
  });

  test("one_off not on the class day returns empty", () => {
    const dates = expandEnrolmentDates(
      {
        frequency: EnrolmentFrequency.OneOff,
        // Apr 16 is Thursday; Wednesday class won't include it.
        startDate: d("2026-04-16"),
        endDate: d("2026-04-16"),
        pauseFrom: null,
        pauseTo: null,
      },
      WeekDay.Wednesday,
      { from: APR_1, to: APR_29 },
    );
    expect(dates).toEqual([]);
  });

  test("pause window straddling the range start excludes early dates", () => {
    const dates = expandEnrolmentDates(
      {
        frequency: EnrolmentFrequency.Weekly,
        startDate: APR_1,
        endDate: null,
        pauseFrom: d("2026-03-30"),
        pauseTo: APR_8,
      },
      WeekDay.Wednesday,
      { from: APR_1, to: APR_29 },
    );
    expect(dates.map(iso)).toEqual([
      "2026-04-15",
      "2026-04-22",
      "2026-04-29",
    ]);
  });

  test("pause window straddling the range end excludes late dates", () => {
    const dates = expandEnrolmentDates(
      {
        frequency: EnrolmentFrequency.Weekly,
        startDate: APR_1,
        endDate: null,
        pauseFrom: APR_22,
        pauseTo: d("2026-05-10"),
      },
      WeekDay.Wednesday,
      { from: APR_1, to: APR_29 },
    );
    expect(dates.map(iso)).toEqual(["2026-04-01", "2026-04-08", "2026-04-15"]);
  });

  test("pause window fully inside range carves out a hole", () => {
    const dates = expandEnrolmentDates(
      {
        frequency: EnrolmentFrequency.Weekly,
        startDate: APR_1,
        endDate: null,
        pauseFrom: APR_8,
        pauseTo: APR_15,
      },
      WeekDay.Wednesday,
      { from: APR_1, to: APR_29 },
    );
    expect(dates.map(iso)).toEqual(["2026-04-01", "2026-04-22", "2026-04-29"]);
  });

  test("end_date earlier than range.to caps the result", () => {
    const dates = expandEnrolmentDates(
      {
        frequency: EnrolmentFrequency.Weekly,
        startDate: APR_1,
        endDate: APR_15,
        pauseFrom: null,
        pauseTo: null,
      },
      WeekDay.Wednesday,
      { from: APR_1, to: APR_29 },
    );
    expect(dates.map(iso)).toEqual(["2026-04-01", "2026-04-08", "2026-04-15"]);
  });

  test("startDate after range.to returns empty", () => {
    const dates = expandEnrolmentDates(
      {
        frequency: EnrolmentFrequency.Weekly,
        startDate: d("2026-05-06"),
        endDate: null,
        pauseFrom: null,
        pauseTo: null,
      },
      WeekDay.Wednesday,
      { from: APR_1, to: APR_29 },
    );
    expect(dates).toEqual([]);
  });
});
