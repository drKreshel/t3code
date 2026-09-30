import type { Automation, AutomationSchedule, AutomationTrigger } from "@t3tools/contracts";

export type RepeatKind = "once" | "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";

/** What the schedule controls hold; compiled to a cron expression (or a date) on save. */
export interface ScheduleForm {
  readonly repeat: RepeatKind;
  /** `HH:MM`, for daily and longer. */
  readonly time: string;
  /** Minute past the hour, for hourly. */
  readonly minute: number;
  /** Days of the week for weekly, 0 = Sunday. */
  readonly days: ReadonlyArray<number>;
  readonly dayOfMonth: number;
  /** `YYYY-MM-DDTHH:MM` in the browser's zone, for once. */
  readonly onceAt: string;
  readonly cron: string;
}

export const DEFAULT_SCHEDULE_FORM: ScheduleForm = {
  repeat: "weekdays",
  time: "09:00",
  minute: 0,
  days: [1],
  dayOfMonth: 1,
  onceAt: "",
  cron: "0 9 * * 1-5",
};

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (value: number) => String(value).padStart(2, "0");

function splitTime(time: string): { readonly hour: number; readonly minute: number } {
  const [hour = "9", minute = "0"] = time.split(":");
  return { hour: Number(hour), minute: Number(minute) };
}

/** The schedule to store, or a message saying what is missing. */
export function formToSchedule(
  form: ScheduleForm,
):
  | { readonly ok: true; readonly schedule: AutomationSchedule }
  | { readonly ok: false; readonly message: string } {
  const { hour, minute } = splitTime(form.time);
  switch (form.repeat) {
    case "once": {
      const at = new Date(form.onceAt);
      if (!form.onceAt || Number.isNaN(at.getTime())) {
        return { ok: false, message: "Pick the date and time to run." };
      }
      return { ok: true, schedule: { kind: "once", at: at.toISOString() } };
    }
    case "hourly":
      return { ok: true, schedule: { kind: "cron", cron: `${form.minute} * * * *` } };
    case "daily":
      return { ok: true, schedule: { kind: "cron", cron: `${minute} ${hour} * * *` } };
    case "weekdays":
      return { ok: true, schedule: { kind: "cron", cron: `${minute} ${hour} * * 1-5` } };
    case "weekly":
      if (form.days.length === 0) return { ok: false, message: "Pick at least one day." };
      return {
        ok: true,
        schedule: {
          kind: "cron",
          cron: `${minute} ${hour} * * ${form.days.toSorted((a, b) => a - b).join(",")}`,
        },
      };
    case "monthly":
      return {
        ok: true,
        schedule: { kind: "cron", cron: `${minute} ${hour} ${form.dayOfMonth} * *` },
      };
    case "custom":
      return form.cron.trim().split(/\s+/).length === 5
        ? { ok: true, schedule: { kind: "cron", cron: form.cron.trim() } }
        : { ok: false, message: "A cron expression has five fields." };
  }
}

const isNumber = (value: string | undefined): value is string =>
  value !== undefined && /^\d+$/.test(value);

/** The form for a stored schedule: the matching preset, else custom. */
export function scheduleToForm(schedule: AutomationSchedule): ScheduleForm {
  if (schedule.kind === "once") {
    const at = new Date(schedule.at);
    const local = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
    return { ...DEFAULT_SCHEDULE_FORM, repeat: "once", onceAt: local };
  }
  const custom: ScheduleForm = { ...DEFAULT_SCHEDULE_FORM, repeat: "custom", cron: schedule.cron };
  const [minute, hour, dayOfMonth, month, dayOfWeek] = schedule.cron.trim().split(/\s+/);
  if (!isNumber(minute) || month !== "*") return custom;
  if (hour === "*" && dayOfMonth === "*" && dayOfWeek === "*") {
    return { ...custom, repeat: "hourly", minute: Number(minute) };
  }
  if (!isNumber(hour)) return custom;
  const base = { ...custom, time: `${pad(Number(hour))}:${pad(Number(minute))}` };
  if (dayOfMonth === "*" && dayOfWeek === "*") return { ...base, repeat: "daily" };
  if (dayOfMonth === "*" && dayOfWeek === "1-5") return { ...base, repeat: "weekdays" };
  if (dayOfMonth === "*" && dayOfWeek !== undefined && /^\d(,\d)*$/.test(dayOfWeek)) {
    return { ...base, repeat: "weekly", days: dayOfWeek.split(",").map(Number) };
  }
  if (isNumber(dayOfMonth) && dayOfWeek === "*") {
    return { ...base, repeat: "monthly", dayOfMonth: Number(dayOfMonth) };
  }
  return custom;
}

/** "Weekdays at 09:00", "Every hour at :15", "Once on …". */
export function describeSchedule(schedule: AutomationSchedule): string {
  const form = scheduleToForm(schedule);
  switch (form.repeat) {
    case "once":
      return `Once on ${new Date((schedule as { readonly at: string }).at).toLocaleString()}`;
    case "hourly":
      return `Every hour at :${pad(form.minute)}`;
    case "daily":
      return `Every day at ${form.time}`;
    case "weekdays":
      return `Weekdays at ${form.time}`;
    case "weekly":
      return `${form.days.map((day) => WEEKDAY_LABELS[day]).join(", ")} at ${form.time}`;
    case "monthly":
      return `Monthly on day ${form.dayOfMonth} at ${form.time}`;
    case "custom":
      return `Cron ${form.cron}`;
  }
}

/** A trigger in words; board names come from the caller. */
export function describeTrigger(
  trigger: AutomationTrigger,
  boardColumnLabel: (boardId: string, columnId: string) => string,
): string {
  if (trigger.type === "board")
    return `When a ticket enters ${boardColumnLabel(trigger.boardId, trigger.columnId)}`;
  return describeSchedule(trigger.schedule);
}

/** Board hooks of one board, by column id. */
export function hooksByColumn(
  automations: ReadonlyArray<Automation>,
  boardId: string,
): Map<string, Automation[]> {
  const byColumn = new Map<string, Automation[]>();
  for (const automation of automations) {
    const { trigger } = automation;
    if (trigger.type !== "board" || trigger.boardId !== boardId) continue;
    const list = byColumn.get(trigger.columnId);
    if (list) list.push(automation);
    else byColumn.set(trigger.columnId, [automation]);
  }
  return byColumn;
}
