import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  isMissedFixedTimeRun,
  isSameSchedule,
  nextScheduledRunAt,
  scheduleProblem,
} from "./Schedule.ts";

describe("scheduled task schedule calculation", () => {
  it("skips to the next matching fixed-time weekday", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      DateTime.makeZonedUnsafe(
        {
          year: 2026,
          month: 7,
          day: 3,
          hour: 10,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  it("compares schedules structurally", () => {
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 60_000 }),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 30_000 }),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:30" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
  });
});

describe("cron, one-off, and timezone schedules", () => {
  const iso = (value: DateTime.DateTime | null) =>
    value ? DateTime.formatIso(DateTime.toUtc(value)) : null;
  const at = (value: string) => DateTime.makeUnsafe(value);

  it("runs cron schedules at every matching minute, in their timezone", () => {
    const halfHourly = {
      type: "cron",
      expression: "15,45 2-19 * * *",
      timezone: "America/Vancouver",
    } as const;
    // 19:45 Vancouver (PDT) is the day's last run; the next is 02:15 the following day.
    expect(iso(nextScheduledRunAt(halfHourly, at("2026-07-01T09:20:00.000Z")))).toBe(
      "2026-07-01T09:45:00.000Z",
    );
    expect(iso(nextScheduledRunAt(halfHourly, at("2026-07-02T02:45:00.000Z")))).toBe(
      "2026-07-02T09:15:00.000Z",
    );
    const monthly = { type: "cron", expression: "0 9 1 * *", timezone: "UTC" } as const;
    expect(iso(nextScheduledRunAt(monthly, at("2026-07-01T09:00:00.000Z")))).toBe(
      "2026-08-01T09:00:00.000Z",
    );
  });

  it("runs a one-off once, then has no next run", () => {
    const once = { type: "once", at: "2026-10-09T09:00", timezone: "Europe/Berlin" } as const;
    expect(iso(nextScheduledRunAt(once, at("2026-10-01T00:00:00.000Z")))).toBe(
      "2026-10-09T07:00:00.000Z",
    );
    expect(nextScheduledRunAt(once, at("2026-10-09T07:00:00.000Z"))).toBeNull();
  });

  it("reads a fixed time in its own timezone", () => {
    const morning = { type: "fixed_time", timeOfDay: "06:00", timezone: "Asia/Tokyo" } as const;
    expect(iso(nextScheduledRunAt(morning, at("2026-07-01T00:00:00.000Z")))).toBe(
      "2026-07-01T21:00:00.000Z",
    );
  });

  it("refuses bad cron, unknown timezones, and one-offs in the past", () => {
    const now = at("2026-10-06T12:00:00.000Z");
    expect(scheduleProblem({ type: "cron", expression: "61 * * * *" }, now)).toMatch(/cron/);
    expect(
      scheduleProblem({ type: "cron", expression: "0 9 * * *", timezone: "Mars/Olympus" }, now),
    ).toMatch(/timezone/);
    expect(scheduleProblem({ type: "once", at: "2026-10-01T09:00", timezone: "UTC" }, now)).toMatch(
      /passed/,
    );
    expect(scheduleProblem({ type: "cron", expression: "*/5 * * * 1-5" }, now)).toBeNull();
  });

  it("treats a timezone change as a schedule change, and spacing in cron as none", () => {
    expect(
      isSameSchedule(
        { type: "cron", expression: "0  9 * * *" },
        { type: "cron", expression: "0 9 * * *" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", timezone: "UTC" },
      ),
    ).toBe(false);
  });
});

describe("missed wall-clock runs", () => {
  const schedule = {
    type: "fixed_time",
    timeOfDay: "14:00",
    timezone: "America/Argentina/Buenos_Aires",
  } as const;
  const dueAt = DateTime.makeUnsafe("2026-10-21T17:00:00.000Z");

  it("still fires a run first polled after the host woke from sleep", () => {
    expect(
      isMissedFixedTimeRun(schedule, dueAt, DateTime.makeUnsafe("2026-10-21T17:12:52.000Z")),
    ).toBe(false);
  });

  it("skips a run that is hours overdue, but never an interval catch-up", () => {
    const now = DateTime.makeUnsafe("2026-10-21T19:00:00.000Z");
    expect(isMissedFixedTimeRun(schedule, dueAt, now)).toBe(true);
    expect(isMissedFixedTimeRun({ type: "interval", everyMs: 60_000 }, dueAt, now)).toBe(false);
  });
});
