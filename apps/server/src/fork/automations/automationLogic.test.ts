import type { AutomationTrigger, Ticket } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  decideSchedule,
  MISSED_GRACE_MS,
  nextScheduledAt,
  renderPrompt,
  scheduleProblem,
} from "./automationLogic.ts";

const at = (input: string | number) => DateTime.makeUnsafe(input);
const iso = (value: DateTime.Utc | null) => (value ? DateTime.formatIso(value) : null);

const weekdaysAtNine: AutomationTrigger = {
  type: "schedule",
  schedule: { kind: "cron", cron: "0 9 * * 1-5" },
  timezone: "Europe/Berlin",
};

describe("nextScheduledAt", () => {
  it("reads cron in the automation's timezone", () => {
    // Friday 2026-10-02 10:00 Berlin (08:00 UTC): next is Monday 09:00 Berlin (07:00 UTC).
    const next = nextScheduledAt(weekdaysAtNine, at("2026-10-02T08:00:00Z"), true);
    expect(iso(next)).toBe("2026-10-05T07:00:00.000Z");
  });

  it("fires a one-off once", () => {
    const once: AutomationTrigger = {
      type: "schedule",
      schedule: { kind: "once", at: "2026-10-01T12:00:00.000Z" },
      timezone: "UTC",
    };
    expect(iso(nextScheduledAt(once, at(0), false))).toBe("2026-10-01T12:00:00.000Z");
    expect(nextScheduledAt(once, at(0), true)).toBeNull();
  });
});

describe("decideSchedule", () => {
  it("runs within the grace window and records older ones as missed", () => {
    const due = at("2026-10-01T09:00:00Z");
    expect(decideSchedule(due, at("2026-10-01T08:59:00Z"))).toBe("wait");
    expect(decideSchedule(due, at("2026-10-01T09:30:00Z"))).toBe("run");
    expect(decideSchedule(due, at(DateTime.toEpochMillis(due) + MISSED_GRACE_MS + 1))).toBe(
      "missed",
    );
    expect(decideSchedule(null, at(0))).toBe("wait");
  });
});

describe("scheduleProblem", () => {
  it("rejects a malformed cron", () => {
    expect(scheduleProblem(weekdaysAtNine)).toBeNull();
    expect(
      scheduleProblem({ ...weekdaysAtNine, schedule: { kind: "cron", cron: "every day" } }),
    ).toMatch(/Invalid schedule/);
  });
});

describe("renderPrompt", () => {
  const ticket = {
    id: "t",
    number: 12,
    title: "Fix login",
    description: "Cookie expires early.",
    criteria: [
      { id: "b", text: "Stays signed in", checked: false, position: 2 },
      { id: "a", text: "Repro written", checked: true, position: 1 },
    ],
  } as unknown as Ticket;

  it("fills ticket and run variables and leaves unknown ones visible", () => {
    const text = renderPrompt(
      "Test {{ticket.key}} ({{ticket.url}}), run {{run.number}}:\n{{ticket.criteria}}\n{{ticket.oops}}",
      {
        ticket: { key: "WEB-12", ticket, boardName: "Web", handoff: null },
        runNumber: 2,
      },
    );
    expect(text).toBe(
      "Test WEB-12 (/boards/WEB/12), run 2:\n- [x] Repro written\n- [ ] Stays signed in\n{{ticket.oops}}",
    );
  });

  it("keeps ticket variables when there is no ticket", () => {
    expect(renderPrompt("Weekly: {{ticket.key}}", { runNumber: 1 })).toBe("Weekly: {{ticket.key}}");
  });
});
