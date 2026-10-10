import {
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
} from "@t3tools/contracts/settings";

export const AUTO_SETTLE_DURATION_UNITS = ["minutes", "hours", "days"] as const;
export type AutoSettleDurationUnit = (typeof AUTO_SETTLE_DURATION_UNITS)[number];

const DAYS_PER_UNIT = {
  minutes: 1 / (24 * 60),
  hours: 1 / 24,
  days: 1,
} satisfies Record<AutoSettleDurationUnit, number>;

export function autoSettleDurationToDays(
  amount: number,
  unit: AutoSettleDurationUnit,
): number | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const days = amount * DAYS_PER_UNIT[unit];
  return days >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS && days <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
    ? days
    : null;
}

export function autoSettleDurationAmount(days: number, unit: AutoSettleDurationUnit): string {
  const amount = days / DAYS_PER_UNIT[unit];
  return String(Number(amount.toPrecision(12)));
}

export function preferredAutoSettleDurationUnit(days: number): AutoSettleDurationUnit {
  if (days < 1 / 24) return "minutes";
  if (days < 1) return "hours";
  return "days";
}
