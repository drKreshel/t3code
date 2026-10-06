/** Pure pieces of the automation engine: schedules and action checks. */
import type { AutomationAction, AutomationTrigger } from "@t3tools/contracts";
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
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

/**
 * A one-off's UTC instant from a typed `at`. Without an offset, `at` is
 * wall-clock time in `timezone`, as people mean "4am Vancouver". Null when
 * either does not parse.
 */
export function onceAtFromInput(at: string, timezone: string): string | null {
  // ISO only: the Date parser also accepts loose text like "tomorrow at 4".
  const iso =
    /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(
      at,
    );
  if (!iso) return null;
  const instant: Option.Option<DateTime.DateTime> = iso[1]
    ? DateTime.make(at)
    : DateTime.makeZoned(at, { timeZone: timezone, adjustForTimeZone: true });
  return Option.isSome(instant) ? DateTime.formatIso(instant.value) : null;
}

/** A trigger as agents read it: cron with its zone, or a one-off's wall-clock time in its zone. */
export function describeTrigger(trigger: AutomationTrigger): string {
  if (trigger.schedule.kind === "cron") {
    return `cron ${trigger.schedule.cron} (${trigger.timezone})`;
  }
  const zoned = DateTime.makeZoned(trigger.schedule.at, { timeZone: trigger.timezone });
  return Option.isSome(zoned)
    ? `once at ${DateTime.formatIsoZoned(zoned.value)}`
    : `once at ${trigger.schedule.at}`;
}
