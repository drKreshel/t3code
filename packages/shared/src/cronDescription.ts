/**
 * Plain-English reading of a five-field cron expression (minute hour
 * day-of-month month day-of-week), such as "Weekdays at 09:00" or "Every hour
 * at :15 and :45, from 02:15 to 19:45". Null when the expression is not one
 * this can read, so callers fall back to showing it as written.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Listing more exact times than this reads worse than describing the pattern. */
const MAX_LISTED_TIMES = 8;

interface CronField {
  /** Every value the field matches, ascending. */
  readonly values: ReadonlyArray<number>;
  /** Written as `*`. */
  readonly any: boolean;
  /** Written as `*\/n`. */
  readonly every: number | null;
}

function parseValue(text: string, names: ReadonlyArray<string> | undefined, offset: number) {
  if (/^\d+$/.test(text)) return Number(text);
  const index = names?.findIndex((name) => name.toLowerCase() === text.toLowerCase()) ?? -1;
  return index === -1 ? null : index + offset;
}

function parseField(
  text: string,
  min: number,
  max: number,
  names?: ReadonlyArray<string>,
  nameOffset = 0,
): CronField | null {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|[^/-]+)(?:-([^/]+))?(?:\/(\d+))?$/.exec(part);
    if (!match) return null;
    const [, startText = "", endText, stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    const start = startText === "*" ? min : parseValue(startText, names, nameOffset);
    const end =
      endText !== undefined
        ? parseValue(endText, names, nameOffset)
        : startText === "*" || stepText !== undefined
          ? max
          : start;
    if (start === null || end === null || step < 1 || start < min || end > max || end < start) {
      return null;
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  const every = /^\*\/(\d+)$/.exec(text);
  return {
    values: [...values].sort((a, b) => a - b),
    any: text === "*",
    every: every ? Number(every[1]) : null,
  };
}

const pad = (value: number) => String(value).padStart(2, "0");
const clock = (hour: number, minute: number) => `${pad(hour)}:${pad(minute)}`;

function listOf(items: ReadonlyArray<string>, conjunction = "and"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`;
}

function ordinal(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) return `${day}th`;
  return `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`;
}

const isContiguous = (values: ReadonlyArray<number>) =>
  values.every((value, index) => index === 0 || value === values[index - 1]! + 1);

function daysPhrase(dayOfMonth: CronField, month: CronField, dayOfWeek: CronField): string {
  const weekdays = dayOfWeek.values;
  const byWeekday = dayOfWeek.any
    ? null
    : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
      ? "weekdays"
      : weekdays.length === 2 && weekdays[0] === 0 && weekdays[1] === 6
        ? "weekends"
        : `every ${listOf(weekdays.map((day) => DAYS[day]!))}`;
  const byDate = dayOfMonth.any ? null : `on the ${listOf(dayOfMonth.values.map(ordinal))}`;
  const months = month.any ? null : listOf(month.values.map((value) => MONTHS[value - 1]!));
  // Cron runs on either one when both a date and a weekday are given.
  const days =
    byDate && byWeekday
      ? `${byDate} or ${byWeekday}`
      : byDate
        ? `${byDate} of ${months ?? "every month"}`
        : (byWeekday ?? "daily");
  return byDate === null && months !== null ? `${days} in ${months}` : days;
}

function timesPhrase(minute: CronField, hour: CronField): string {
  if (
    !minute.any &&
    minute.every === null &&
    !hour.any &&
    minute.values.length * hour.values.length <= MAX_LISTED_TIMES
  ) {
    return `at ${listOf(hour.values.flatMap((h) => minute.values.map((m) => clock(h, m))))}`;
  }
  const minutes = minute.any
    ? "every minute"
    : minute.every !== null
      ? `every ${minute.every} minutes`
      : `every hour at ${listOf(minute.values.map((m) => `:${pad(m)}`))}`;
  if (hour.any) return minutes;
  if (hour.every !== null) {
    return minute.any || minute.every !== null
      ? `${minutes} in every ${ordinal(hour.every)} hour`
      : `every ${hour.every} hours at ${listOf(minute.values.map((m) => `:${pad(m)}`))}`;
  }
  const first = hour.values[0]!;
  const last = hour.values.at(-1)!;
  if (isContiguous(hour.values)) {
    return `${minutes}, from ${clock(first, minute.values[0]!)} to ${clock(last, minute.values.at(-1)!)}`;
  }
  return `${minutes}, in the ${listOf(hour.values.map((h) => `${pad(h)}:00`))} hours`;
}

export function describeCron(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteText, hourText, dayOfMonthText, monthText, dayOfWeekText] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const minute = parseField(minuteText, 0, 59);
  const hour = parseField(hourText, 0, 23);
  const dayOfMonth = parseField(dayOfMonthText, 1, 31);
  const month = parseField(monthText, 1, 12, MONTHS, 1);
  const rawDayOfWeek = parseField(dayOfWeekText, 0, 7, DAYS);
  if (!minute || !hour || !dayOfMonth || !month || !rawDayOfWeek) return null;
  // 7 is another way to write Sunday.
  const dayOfWeek: CronField = {
    ...rawDayOfWeek,
    values: [...new Set(rawDayOfWeek.values.map((day) => day % 7))].sort((a, b) => a - b),
  };

  const days = daysPhrase(dayOfMonth, month, dayOfWeek);
  const times = timesPhrase(minute, hour);
  const sentence = times.startsWith("at ")
    ? `${days} ${times}`
    : days === "daily"
      ? times
      : `${days}, ${times}`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
