import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  type ScheduledTaskSchedule,
  type ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

const MINUTE_MS = 60_000;

export function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * The zone a schedule's times are read in: its own, or else `from`'s (the
 * server's local zone in production). Null for an unknown name.
 */
function scheduleZone(
  timezone: string | undefined,
  from: DateTime.DateTime,
): DateTime.TimeZone | null {
  if (timezone !== undefined) return Option.getOrNull(DateTime.zoneMakeNamed(timezone));
  return DateTime.isZoned(from) ? from.zone : DateTime.zoneMakeLocal();
}

/** A one-off's instant: its wall-clock `at` read in its zone. */
function onceInstant(
  schedule: Extract<ScheduledTaskSchedule, { type: "once" }>,
  from: DateTime.DateTime,
): DateTime.DateTime | null {
  const zone = scheduleZone(schedule.timezone, from);
  if (zone === null) return null;
  return Option.getOrNull(
    DateTime.makeZoned(schedule.at, { timeZone: zone, adjustForTimeZone: true }),
  );
}

/** Why a schedule cannot run, or null. Saves refuse schedules with a problem. */
export function scheduleProblem(
  schedule: ScheduledTaskSchedule | ScheduledTaskUpsertSchedule,
  now: DateTime.DateTime,
): string | null {
  if (schedule.type === "interval" || schedule.type === "webhook") return null;
  if (scheduleZone(schedule.timezone, now) === null) {
    return `Unknown timezone "${schedule.timezone}". Use an IANA name such as America/Vancouver.`;
  }
  if (schedule.type === "cron") {
    const parsed = Cron.parse(schedule.expression);
    return Result.isFailure(parsed) ? `Invalid cron expression: ${parsed.failure.message}` : null;
  }
  if (schedule.type === "once") {
    const at = onceInstant(schedule, now);
    if (at === null) return `Invalid date and time "${schedule.at}".`;
    return DateTime.toEpochMillis(at) <= DateTime.toEpochMillis(now)
      ? `${schedule.at} has already passed.`
      : null;
  }
  return null;
}

export function nextScheduledRunAt(
  schedule: ScheduledTaskSchedule,
  from: DateTime.DateTime,
): DateTime.DateTime | null {
  if (schedule.type === "webhook") return null;
  if (schedule.type === "once") {
    const at = onceInstant(schedule, from);
    return at !== null && DateTime.toEpochMillis(at) > DateTime.toEpochMillis(from) ? at : null;
  }
  if (schedule.type === "cron") {
    const zone = scheduleZone(schedule.timezone, from);
    const parsed = zone === null ? null : Cron.parse(schedule.expression, zone);
    if (parsed === null || Result.isFailure(parsed)) return null;
    return DateTime.fromDateUnsafe(Cron.next(parsed.success, from));
  }
  if (schedule.type === "interval") {
    // Persisted rows created before the one-minute floor remain readable, but
    // they must not retain their old high-frequency execution rate.
    return DateTime.add(from, {
      milliseconds: Math.max(schedule.everyMs, MIN_SCHEDULED_TASK_INTERVAL_MS),
    });
  }

  const time = parseTimeOfDay(schedule.timeOfDay);
  const zone = scheduleZone(schedule.timezone, from);
  if (time === null || zone === null) return null;
  // Days and times step in the schedule's zone, so DST shifts keep the wall-clock time.
  const zonedFrom = schedule.timezone === undefined ? from : DateTime.setZone(from, zone);
  const weekdays =
    schedule.weekdays && schedule.weekdays.length > 0 ? new Set(schedule.weekdays) : null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = DateTime.setParts(DateTime.add(zonedFrom, { days: offset }), {
      hour: time.hour,
      minute: time.minute,
      second: 0,
      millisecond: 0,
    });
    if (DateTime.toEpochMillis(candidate) <= DateTime.toEpochMillis(from)) continue;
    if (weekdays !== null && !weekdays.has(DateTime.toParts(candidate).weekDay)) continue;
    return candidate;
  }
  return null;
}

/**
 * Canonical form of a weekday mask, mirroring how `nextScheduledRunAt` reads
 * it: order and duplicates are irrelevant, and an empty/omitted mask means the
 * same as explicitly listing all seven days — daily.
 */
function weekdayKey(weekdays: ReadonlyArray<number> | undefined): string {
  const unique = [...new Set(weekdays ?? [])].toSorted((x, y) => x - y);
  if (unique.length === 0 || unique.length === 7) return "daily";
  return unique.join(",");
}

/** Semantic equality for schedules: true iff both fire at the same times. */
export function isSameSchedule(a: ScheduledTaskSchedule, b: ScheduledTaskSchedule): boolean {
  if (a.type === "interval") {
    return b.type === "interval" && a.everyMs === b.everyMs;
  }
  // Webhook tasks never have a next run, whatever their signature settings.
  if (a.type === "webhook") return b.type === "webhook";
  if (a.type === "cron") {
    return (
      b.type === "cron" &&
      a.expression.trim().split(/\s+/).join(" ") === b.expression.trim().split(/\s+/).join(" ") &&
      a.timezone === b.timezone
    );
  }
  if (a.type === "once") return b.type === "once" && a.at === b.at && a.timezone === b.timezone;
  if (b.type !== "fixed_time") return false;
  // The contract accepts padded and unpadded hours ("9:00" and "09:00"), so
  // compare the parsed time — string equality would treat a format-only edit
  // as a schedule change and recompute the pending run.
  const aTime = parseTimeOfDay(a.timeOfDay);
  const bTime = parseTimeOfDay(b.timeOfDay);
  return (
    aTime !== null &&
    bTime !== null &&
    aTime.hour === bTime.hour &&
    aTime.minute === bTime.minute &&
    weekdayKey(a.weekdays) === weekdayKey(b.weekdays) &&
    a.timezone === b.timezone
  );
}

/**
 * How late a fixed-time run may fire before it counts as missed. Covers poll
 * jitter and short sleeps, while a server booted hours after the slot skips
 * to the next occurrence instead of firing stale work at a random time.
 */
const MISSED_FIXED_TIME_GRACE_MS = 10 * MINUTE_MS;

/**
 * True when a due wall-clock run (fixed time, cron, or one-off) was missed by
 * more than the grace window and should be rescheduled to its next occurrence
 * instead of firing now; a missed one-off has none. Interval schedules are
 * never considered missed: an overdue interval task catching up with a single
 * run is the desired behaviour.
 */
export function isMissedFixedTimeRun(
  schedule: ScheduledTaskSchedule,
  dueAt: DateTime.DateTime,
  now: DateTime.DateTime,
): boolean {
  if (schedule.type === "interval" || schedule.type === "webhook") return false;
  return DateTime.toEpochMillis(now) - DateTime.toEpochMillis(dueAt) > MISSED_FIXED_TIME_GRACE_MS;
}

function describeSchedule(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "webhook") return "On webhook";
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / MINUTE_MS;
    if (Number.isInteger(minutes)) {
      return `Every ${minutes === 1 ? "minute" : `${minutes} minutes`}`;
    }
    return `Every ${Math.round(schedule.everyMs / 1000)} seconds`;
  }
  if (schedule.type === "cron") return `Cron ${schedule.expression}`;
  if (schedule.type === "once") return `Once at ${schedule.at}`;

  const weekdayCount = schedule.weekdays?.length ?? 0;
  const days =
    weekdayCount === 0
      ? "day"
      : weekdayCount === 5 && schedule.weekdays?.every((day) => day >= 1 && day <= 5)
        ? "weekday"
        : "selected day";
  return `At ${schedule.timeOfDay} every ${days}`;
}
