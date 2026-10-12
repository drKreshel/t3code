import { describe, expect, it } from "vite-plus/test";

import {
  autoSettleDurationAmount,
  autoSettleDurationToDays,
  preferredAutoSettleDurationUnit,
} from "./autoSettleDuration.ts";

describe("auto-settle duration", () => {
  it.each([
    ["minutes", 30, 30 / (24 * 60)],
    ["hours", 4, 4 / 24],
    ["days", 3, 3],
  ] as const)("converts %s to the persisted day value", (unit, amount, days) => {
    expect(autoSettleDurationToDays(amount, unit)).toBeCloseTo(days, 12);
    expect(autoSettleDurationAmount(days, unit)).toBe(String(amount));
  });

  it.each([
    [30 / (24 * 60), "minutes"],
    [4 / 24, "hours"],
    [3, "days"],
  ] as const)("presents %s days as %s", (days, unit) => {
    expect(preferredAutoSettleDurationUnit(days)).toBe(unit);
  });

  it.each([
    [0, "minutes"],
    [0.5, "minutes"],
    [2_161, "hours"],
    [Number.POSITIVE_INFINITY, "days"],
  ] as const)("rejects an unsupported %s %s duration", (amount, unit) => {
    expect(autoSettleDurationToDays(amount, unit)).toBeNull();
  });
});
