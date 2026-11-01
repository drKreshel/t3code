import { describe, expect, it } from "@effect/vitest";

import { convertLegacyOnceSchedule } from "./legacyOnceSchedules.ts";

describe("convertLegacyOnceSchedule", () => {
  it.each([
    [
      { type: "once", at: "2026-11-02T09:00", timezone: "America/Argentina/Buenos_Aires" },
      {
        type: "once",
        runAt: "2026-11-02T12:00:00.000Z",
        timezone: "America/Argentina/Buenos_Aires",
      },
    ],
    [{ type: "once", at: "2026-11-02T09:00", timezone: "Mars/Olympus" }, null],
    [{ type: "once", at: "2027-03-14T02:30", timezone: "America/Vancouver" }, null],
    [{ type: "once", runAt: "2026-11-02T12:00:00.000Z" }, null],
  ])("converts %j", (legacy, expected) => {
    const converted = convertLegacyOnceSchedule(JSON.stringify(legacy));
    expect(converted === null ? null : JSON.parse(converted)).toEqual(expected);
  });
});
