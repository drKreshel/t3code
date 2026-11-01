// @effect-diagnostics globalDate:off -- Clients convert `datetime-local` input values, which are plain Dates, through Intl.
/**
 * Wall-clock `YYYY-MM-DDTHH:MM` values read in an IANA timezone, as a
 * `datetime-local` input shows them. Without a timezone, the runtime's own.
 */

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Minutes the zone is ahead of UTC at an instant. */
function zoneOffsetMinutes(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epochMs));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  const wallAsUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return Math.round((wallAsUtc - Math.floor(epochMs / 1000) * 1000) / 60_000);
}

export function isKnownTimeZone(timeZone: string): boolean {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
}

export function toZonedLocalValue(date: Date, timeZone?: string): string {
  const shifted =
    timeZone === undefined
      ? new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
      : new Date(date.getTime() + zoneOffsetMinutes(date.getTime(), timeZone) * 60_000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

/**
 * The instant a wall-clock value names, or null when the zone skips that time.
 * In an hour that repeats, `preferOffsetMinutes` picks the matching one, else the earlier.
 */
export function fromZonedLocalValue(
  value: string,
  timeZone?: string,
  preferOffsetMinutes?: number,
): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const wallAsUtc = Date.parse(`${value}:00Z`);
  if (Number.isNaN(wallAsUtc)) return null;
  const offsetAt = (epochMs: number) =>
    timeZone === undefined
      ? -new Date(epochMs).getTimezoneOffset()
      : zoneOffsetMinutes(epochMs, timeZone);
  const guesses = new Set([
    ...(preferOffsetMinutes === undefined ? [] : [preferOffsetMinutes]),
    offsetAt(wallAsUtc - 12 * 3_600_000),
    offsetAt(wallAsUtc + 12 * 3_600_000),
  ]);
  const matches = [...guesses]
    .map((offset) => new Date(wallAsUtc - offset * 60_000))
    .filter((candidate) => toZonedLocalValue(candidate, timeZone) === value);
  if (matches.length === 0) return null;
  if (preferOffsetMinutes !== undefined) {
    const preferred = matches.find(
      (candidate) => offsetAt(candidate.getTime()) === preferOffsetMinutes,
    );
    if (preferred) return preferred;
  }
  return matches.reduce((earliest, candidate) =>
    candidate.getTime() < earliest.getTime() ? candidate : earliest,
  );
}

/** Offset in minutes ahead of UTC that a zone (or the runtime's) uses at an instant. */
export function zonedOffsetMinutes(date: Date, timeZone?: string): number {
  return timeZone === undefined
    ? -date.getTimezoneOffset()
    : zoneOffsetMinutes(date.getTime(), timeZone);
}
