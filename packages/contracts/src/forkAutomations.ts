/**
 * Automations (fork feature): a trigger (a schedule, or a ticket entering a
 * board column) starts a chat with a prompt. Stored next to boards in the
 * environment's `fork.sqlite`.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const FORK_AUTOMATIONS_WS_METHODS = {
  subscribe: "fork.automations.subscribe",
  dispatch: "fork.automations.dispatch",
} as const;

/**
 * When a schedule fires. `cron` is a five-field expression (minute hour
 * day-of-month month day-of-week) read in `timezone`; the UI's presets
 * (hourly, daily, weekdays, weekly, monthly) all compile to one.
 */
export const AutomationSchedule = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("once"), at: IsoDateTime }),
  Schema.Struct({ kind: Schema.Literal("cron"), cron: TrimmedNonEmptyString }),
]);
export type AutomationSchedule = typeof AutomationSchedule.Type;

export const AutomationTrigger = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("schedule"),
    schedule: AutomationSchedule,
    /** IANA zone, like Europe/Berlin. */
    timezone: TrimmedNonEmptyString,
  }),
  /**
   * A ticket entering a column (by any move, or created in it). With a board,
   * `columnId` names the column. With `boardId` null the hook applies to every
   * board, matching columns by name (case-insensitive).
   */
  Schema.Struct({
    type: Schema.Literal("board"),
    boardId: Schema.NullOr(TrimmedNonEmptyString),
    columnId: Schema.NullOr(TrimmedNonEmptyString),
    columnName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    /** @deprecated Stored by older versions; read as the type's default column name. */
    columnType: Schema.optional(Schema.NullOr(Schema.String)),
  }),
]);
export type AutomationTrigger = typeof AutomationTrigger.Type;

/**
 * Where the chat runs: the project's checkout, a fresh worktree per run, or
 * the ticket's workspace (board hooks only; shared by every chat on the ticket).
 */
export const AutomationCheckout = Schema.Literals(["local", "worktree", "ticket"]);
export type AutomationCheckout = typeof AutomationCheckout.Type;

/** How the started chat runs. Nulls fall back to defaults at run time. */
/**
 * A built-in action: applied instantly by the server, no chat, no tokens.
 * Ticket steps act on the ticket that triggered a board hook; `moveStale`
 * sweeps every board, for schedules.
 */
export const AutomationStep = Schema.Union([
  /** Moves the ticket to the column with this name on its board. */
  Schema.Struct({ type: Schema.Literal("moveTo"), column: TrimmedNonEmptyString }),
  /** Removes the ticket's worktrees (branches stay); refused while work is unsaved. */
  Schema.Struct({ type: Schema.Literal("removeWorkspace") }),
  /**
   * Moves tickets that sat in `from` longer than the given days into `to`, on
   * the board named by `boardId`, or on every board with those columns.
   */
  Schema.Struct({
    type: Schema.Literal("moveStale"),
    from: TrimmedNonEmptyString,
    to: TrimmedNonEmptyString,
    olderThanDays: PositiveInt,
    boardId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  }),
]);
export type AutomationStep = typeof AutomationStep.Type;

export const AutomationAction = Schema.Struct({
  /**
   * Scoped project key (`environmentId:projectId`). Required for schedules;
   * board hooks fall back to the ticket's project, then the board's default.
   */
  projectKey: Schema.NullOr(Schema.String),
  /** Null: the project's (or server's) default model. */
  modelSelection: Schema.NullOr(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  checkout: AutomationCheckout,
  /**
   * When set, the automation runs these steps instead of starting a chat, and
   * the chat fields above are ignored.
   */
  steps: Schema.optional(Schema.Array(AutomationStep)),
});
export type AutomationAction = typeof AutomationAction.Type;

export const Automation = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  /**
   * Sent as the chat's first message; `{{ticket.key}}`-style variables are
   * filled in. Empty for automations that run steps.
   */
  prompt: Schema.String,
  trigger: AutomationTrigger,
  action: AutomationAction,
  enabled: Schema.Boolean,
  /** Board hooks: runs per ticket before the ticket goes to Needs you. */
  maxRunsPerTicket: PositiveInt,
  /** Schedules: when it fires next, if enabled. */
  nextRunAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Automation = typeof Automation.Type;

export const AutomationRunStatus = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "missed",
  "skipped",
]);
export type AutomationRunStatus = typeof AutomationRunStatus.Type;

export const AutomationRun = Schema.Struct({
  id: TrimmedNonEmptyString,
  automationId: TrimmedNonEmptyString,
  ticketId: Schema.NullOr(Schema.String),
  /** Scoped thread key of the chat the run started. */
  threadKey: Schema.NullOr(Schema.String),
  status: AutomationRunStatus,
  /** Why it failed, was skipped, or was missed. */
  reason: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type AutomationRun = typeof AutomationRun.Type;

/** Per-board hook state. */
export const BoardHookState = Schema.Struct({
  boardId: TrimmedNonEmptyString,
  paused: Schema.Boolean,
});
export type BoardHookState = typeof BoardHookState.Type;

/** Every automation, recent runs, and paused boards; streamed whole. */
export const AutomationsSnapshot = Schema.Struct({
  automations: Schema.Array(Automation),
  runs: Schema.Array(AutomationRun),
  boardHooks: Schema.Array(BoardHookState),
});
export type AutomationsSnapshot = typeof AutomationsSnapshot.Type;

const command = <Type extends string, Fields extends Schema.Struct.Fields>(
  type: Type,
  fields: Fields,
) => Schema.Struct({ type: Schema.Literal(type), ...fields });

const Id = TrimmedNonEmptyString;

export const AutomationsCommand = Schema.Union([
  command("automation.create", {
    title: TrimmedNonEmptyString,
    prompt: Schema.String,
    trigger: AutomationTrigger,
    action: AutomationAction,
    enabled: Schema.optional(Schema.Boolean),
    maxRunsPerTicket: Schema.optional(PositiveInt),
  }),
  command("automation.update", {
    automationId: Id,
    title: Schema.optional(TrimmedNonEmptyString),
    prompt: Schema.optional(Schema.String),
    trigger: Schema.optional(AutomationTrigger),
    action: Schema.optional(AutomationAction),
    enabled: Schema.optional(Schema.Boolean),
    maxRunsPerTicket: Schema.optional(PositiveInt),
  }),
  command("automation.delete", { automationId: Id }),
  /** Runs a schedule now; a board hook needs the ticket to run for. */
  command("automation.runNow", { automationId: Id, ticketId: Schema.optional(Id) }),
  /** Resets a ticket's hook run counts and runs the hook for its current column. */
  command("ticket.resumeHooks", { ticketId: Id }),
  command("board.pauseHooks", { boardId: Id, paused: Schema.Boolean }),
]);
export type AutomationsCommand = typeof AutomationsCommand.Type;

export const AutomationsCommandResult = Schema.Struct({ id: Schema.NullOr(Schema.String) });
export type AutomationsCommandResult = typeof AutomationsCommandResult.Type;

export class AutomationsCommandError extends Schema.TaggedError<AutomationsCommandError>()(
  "AutomationsCommandError",
  {
    code: Schema.Literals(["not-found", "invalid", "storage"]),
    message: Schema.String,
  },
) {}

export const ForkAutomationsSubscribeRpc = Rpc.make(FORK_AUTOMATIONS_WS_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: AutomationsSnapshot,
  error: Schema.Union([AutomationsCommandError, EnvironmentAuthorizationError]),
  stream: true,
});

export const ForkAutomationsDispatchRpc = Rpc.make(FORK_AUTOMATIONS_WS_METHODS.dispatch, {
  payload: AutomationsCommand,
  success: AutomationsCommandResult,
  error: Schema.Union([AutomationsCommandError, EnvironmentAuthorizationError]),
});

/** The column names older any-board hooks meant by their stored column type. */
const LEGACY_TYPE_NAMES: Record<string, string> = {
  backlog: "Backlog",
  todo: "Todo",
  active: "In progress",
  review: "Testing",
  attention: "Needs you",
  done: "Done",
  canceled: "Canceled",
};

/** The column name an any-board trigger watches, or null. */
export function anyBoardColumnName(trigger: AutomationTrigger): string | null {
  if (trigger.type !== "board" || trigger.boardId !== null) return null;
  if (trigger.columnName) return trigger.columnName;
  return trigger.columnType ? (LEGACY_TYPE_NAMES[trigger.columnType] ?? null) : null;
}
