/** Pure pieces of the automation engine: schedules and prompt variables. */
import type {
  AutomationAction,
  AutomationTrigger,
  BoardsSnapshot,
  Ticket,
} from "@t3tools/contracts";
import { anyBoardColumnName } from "@t3tools/contracts";
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
 * Null for board triggers, a one-off that already fired, or an invalid cron.
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
 * Whether a board trigger applies to a ticket where it sits now. A board
 * trigger names its column; an any-board trigger (`boardId` null) matches
 * columns by name on whichever board the ticket is on.
 */
export function boardTriggerMatches(
  trigger: AutomationTrigger,
  snapshot: BoardsSnapshot,
  ticket: Ticket,
): boolean {
  if (trigger.type !== "board") return false;
  if (trigger.boardId !== null) {
    return trigger.boardId === ticket.boardId && trigger.columnId === ticket.columnId;
  }
  const name = anyBoardColumnName(trigger);
  if (name === null) return false;
  const board = snapshot.boards.find((candidate) => candidate.id === ticket.boardId);
  const column = board?.columns.find((candidate) => candidate.id === ticket.columnId);
  return column !== undefined && column.name.trim().toLowerCase() === name.trim().toLowerCase();
}

/** Why a board trigger is incomplete, or null. */
export function boardTriggerProblem(trigger: AutomationTrigger): string | null {
  if (trigger.type !== "board") return null;
  if (trigger.boardId !== null) {
    return trigger.columnId ? null : "Pick the column the hook watches.";
  }
  return anyBoardColumnName(trigger) ? null : "Name the column the hook watches on every board.";
}

/**
 * Why an automation's action does not fit its trigger, or null. Chat
 * automations need a prompt; ticket steps need a board trigger; sweeping
 * steps belong to schedules.
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
    } else if (trigger.type !== "board") {
      return "Steps that act on a ticket run when a ticket enters a column.";
    }
  }
  return null;
}

export { anyBoardColumnName };

/** The zone the server runs in; T3 Code's server is usually the user's own machine. */
export const serverTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
