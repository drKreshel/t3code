import { describe, expect, it } from "vite-plus/test";
import { AutomationsCommandError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import {
  automationFailureMessage,
  DEFAULT_SCHEDULE_FORM,
  describeSchedule,
  formToSchedule,
  scheduleToForm,
  type ScheduleForm,
} from "./automations.logic";

const cronOf = (form: Partial<ScheduleForm>) => {
  const result = formToSchedule({ ...DEFAULT_SCHEDULE_FORM, ...form });
  return result.ok && result.schedule.kind === "cron" ? result.schedule.cron : null;
};

describe("formToSchedule", () => {
  it("compiles each preset to cron", () => {
    expect(cronOf({ repeat: "hourly", minute: 15 })).toBe("15 * * * *");
    expect(cronOf({ repeat: "daily", time: "07:30" })).toBe("30 7 * * *");
    expect(cronOf({ repeat: "weekdays", time: "09:00" })).toBe("0 9 * * 1-5");
    expect(cronOf({ repeat: "weekly", time: "18:05", days: [5, 1] })).toBe("5 18 * * 1,5");
    expect(cronOf({ repeat: "monthly", time: "08:00", dayOfMonth: 15 })).toBe("0 8 15 * *");
  });

  it("says what is missing", () => {
    expect(formToSchedule({ ...DEFAULT_SCHEDULE_FORM, repeat: "weekly", days: [] })).toEqual({
      ok: false,
      message: "Pick at least one day.",
    });
    expect(formToSchedule({ ...DEFAULT_SCHEDULE_FORM, repeat: "custom", cron: "0 9" }).ok).toBe(
      false,
    );
    expect(formToSchedule({ ...DEFAULT_SCHEDULE_FORM, repeat: "once", onceAt: "" }).ok).toBe(false);
  });
});

describe("automationFailureMessage", () => {
  it("shows an incompatible server's string RPC defect instead of a generic error", () => {
    const message = 'Expected schedule or board at ["trigger"]';
    expect(automationFailureMessage(Cause.die(message))).toBe(message);
  });

  it("preserves declared command errors and native exceptions", () => {
    expect(
      automationFailureMessage(
        Cause.fail(new AutomationsCommandError({ code: "invalid", message: "Choose a project." })),
      ),
    ).toBe("Choose a project.");
    expect(automationFailureMessage(Cause.die(new Error("Connection closed.")))).toBe(
      "Connection closed.",
    );
  });
});

describe("scheduleToForm", () => {
  it("round-trips presets and falls back to custom", () => {
    for (const form of [
      { repeat: "hourly", minute: 45 },
      { repeat: "daily", time: "06:15" },
      { repeat: "weekdays", time: "09:00" },
      { repeat: "weekly", time: "10:00", days: [2, 4] },
      { repeat: "monthly", time: "08:00", dayOfMonth: 1 },
    ] as const) {
      const result = formToSchedule({ ...DEFAULT_SCHEDULE_FORM, ...form });
      if (!result.ok) throw new Error(result.message);
      expect(scheduleToForm(result.schedule)).toMatchObject(form);
    }
    expect(scheduleToForm({ kind: "cron", cron: "*/5 9-17 * * 1-5" }).repeat).toBe("custom");
  });
});

describe("describeSchedule", () => {
  it("reads like the form", () => {
    expect(describeSchedule({ kind: "cron", cron: "0 9 * * 1-5" })).toBe("Weekdays at 09:00");
    expect(describeSchedule({ kind: "cron", cron: "15 * * * *" })).toBe("Every hour at :15");
    expect(describeSchedule({ kind: "cron", cron: "0 18 * * 1,5" })).toBe("Mon, Fri at 18:00");
  });
});
