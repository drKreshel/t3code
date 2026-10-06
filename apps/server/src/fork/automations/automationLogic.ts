/** Pure pieces of the automation engine: schedules and action checks. */
import type { AutomationAction, AutomationTrigger } from "@t3tools/contracts";
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

/** A schedule missed by more than this (the app was off) is recorded as missed, not run. */
export const MISSED_GRACE_MS = 60 * 60 * 1000;

/** Why a schedule is invalid, or null. */
export function scheduleProblem(trigger: AutomationTrigger): string | null {
  if (trigger.schedule.kind === "once") return null;
  const parsed = Cron.parse(trigger.schedule.cron, trigger.timezone);
  return Result.isFailure(parsed) ? `Invalid schedule: ${parsed.failure.message}` : null;
}

/**
 * When a schedule fires next after `after` (its last firing, or its creation).
 * Null for a one-off that already fired, or an invalid cron.
 */
export function nextScheduledAt(
  trigger: AutomationTrigger,
  after: DateTime.Utc,
  firedBefore: boolean,
): DateTime.Utc | null {
  if (trigger.schedule.kind === "once") {
    return firedBefore ? null : DateTime.makeUnsafe(trigger.schedule.at);
  }
  const parsed = Cron.parse(trigger.schedule.cron, trigger.timezone);
  return Result.isSuccess(parsed)
    ? DateTime.fromDateUnsafe(Cron.next(parsed.success, after))
    : null;
}

export type ScheduleDecision = "wait" | "run" | "missed";

/** Whether a schedule due at `due` should run now, is still ahead, or was missed. */
export function decideSchedule(due: DateTime.Utc | null, now: DateTime.Utc): ScheduleDecision {
  if (due === null) return "wait";
  const late = DateTime.toEpochMillis(now) - DateTime.toEpochMillis(due);
  if (late < 0) return "wait";
  return late > MISSED_GRACE_MS ? "missed" : "run";
}

/** Why an automation's action is incomplete, or null. */
export function stepsProblem(action: AutomationAction, prompt: string): string | null {
  if ((action.steps ?? []).length === 0) {
    return prompt.trim() ? null : "Write the prompt the chat starts with.";
  }
  return null;
}

/** The zone the server runs in; T3 Code's server is usually the user's own machine. */
export const serverTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
