/** Pure pieces of the automation engine: schedules and prompt variables. */
import type { AutomationAction, AutomationTrigger, Ticket } from "@t3tools/contracts";
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

/** A schedule missed by more than this (the app was off) is recorded as missed, not run. */
export const MISSED_GRACE_MS = 60 * 60 * 1000;

/** Why a schedule is invalid, or null. */
export function scheduleProblem(trigger: AutomationTrigger): string | null {
  if (trigger.type !== "schedule") return null;
  if (trigger.schedule.kind === "once") return null;
  const parsed = Cron.parse(trigger.schedule.cron, trigger.timezone);
  return Result.isFailure(parsed) ? `Invalid schedule: ${parsed.failure.message}` : null;
}

/**
 * When a schedule fires next after `after` (its last firing, or its creation).
 * Null for workflow presets, legacy board triggers, a one-off that already fired, or an invalid cron.
 */
export function nextScheduledAt(
  trigger: AutomationTrigger,
  after: DateTime.Utc,
  firedBefore: boolean,
): DateTime.Utc | null {
  if (trigger.type !== "schedule") return null;
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

export interface PromptContext {
  readonly ticket?: {
    readonly key: string;
    readonly ticket: Ticket;
    readonly boardName: string;
    readonly handoff: string | null;
  };
  readonly runNumber: number;
}

/**
 * Fills `{{ticket.key}}`-style variables. Unknown variables, and ticket ones
 * without a ticket, are left as written so a typo stays visible.
 */
export function renderPrompt(template: string, context: PromptContext): string {
  const { ticket } = context;
  const values: Record<string, string | undefined> = {
    "run.number": String(context.runNumber),
    ...(ticket
      ? {
          "ticket.key": ticket.key,
          "ticket.title": ticket.ticket.title,
          "ticket.description": ticket.ticket.description,
          "ticket.criteria": ticket.ticket.criteria
            .toSorted((a, b) => a.position - b.position)
            .map((criterion) => `- [${criterion.checked ? "x" : " "}] ${criterion.text}`)
            .join("\n"),
          "ticket.handoff": ticket.handoff ?? "",
          "ticket.url": `/boards/${ticket.key.slice(0, ticket.key.lastIndexOf("-"))}/${ticket.ticket.number}`,
          "board.name": ticket.boardName,
        }
      : {}),
  };
  return template.replace(
    /\{\{\s*([a-z.]+)\s*\}\}/g,
    (match, name: string) => values[name] ?? match,
  );
}

/**
 * Why an automation's action does not fit its trigger, or null. Workflows
 * use instructions; schedules can start chats or sweep old tickets.
 */
export function stepsProblem(
  trigger: AutomationTrigger,
  action: AutomationAction,
  prompt: string,
): string | null {
  const steps = action.steps ?? [];
  if (trigger.type === "workflow") {
    if (steps.length > 0)
      return "Workflows use instructions rather than built-in automation steps.";
    if (action.checkout === "worktree")
      return "Use the ticket workspace or shared project for a workflow.";
  }
  if (steps.length === 0) {
    return prompt.trim() ? null : "Write the prompt the chat starts with.";
  }
  for (const step of steps) {
    if (step.type === "moveStale") {
      if (trigger.type !== "schedule") return "Moving stale tickets runs on a schedule.";
    } else {
      return "Ticket actions belong in workflow instructions.";
    }
  }
  return null;
}

/** The zone the server runs in; T3 Code's server is usually the user's own machine. */
export const serverTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
