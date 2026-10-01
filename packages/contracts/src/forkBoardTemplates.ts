/**
 * Board templates (fork feature): columns plus the automations that give them
 * behavior. Creating a board from one copies both; the board and its
 * automations are then independent of the template. Built-in templates ship
 * with T3; saved ones live in the environment's `fork.sqlite`.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { AutomationAction, AutomationSchedule } from "./forkAutomations.ts";
import { BoardKey, BoardsCommandError, ColumnSpec } from "./forkBoards.ts";

export const FORK_TEMPLATES_WS_METHODS = {
  subscribe: "fork.templates.subscribe",
  dispatch: "fork.templates.dispatch",
} as const;

/**
 * An automation a template creates. A hook names its column; a schedule's
 * "move old tickets" steps act on the new board only.
 */
export const TemplateAutomation = Schema.Struct({
  title: TrimmedNonEmptyString,
  prompt: Schema.String,
  trigger: Schema.Union([
    Schema.Struct({ type: Schema.Literal("board"), column: TrimmedNonEmptyString }),
    Schema.Struct({
      type: Schema.Literal("schedule"),
      schedule: AutomationSchedule,
      /** Null: the server's zone when the board is created. */
      timezone: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ]),
  action: AutomationAction,
  enabled: Schema.Boolean,
  maxRunsPerTicket: PositiveInt,
});
export type TemplateAutomation = typeof TemplateAutomation.Type;

export const BoardTemplate = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.String,
  /** Ships with T3; cannot be deleted. */
  builtIn: Schema.Boolean,
  columns: Schema.Array(ColumnSpec),
  automations: Schema.Array(TemplateAutomation),
});
export type BoardTemplate = typeof BoardTemplate.Type;

/** Built-in templates first, then saved ones by name. */
export const TemplatesSnapshot = Schema.Struct({ templates: Schema.Array(BoardTemplate) });
export type TemplatesSnapshot = typeof TemplatesSnapshot.Type;

const Id = TrimmedNonEmptyString;

export const TemplatesCommand = Schema.Union([
  /** Creates a board with the template's columns and automations. */
  Schema.Struct({
    type: Schema.Literal("board.create"),
    templateId: Id,
    name: TrimmedNonEmptyString,
    key: BoardKey,
    defaultProjectKey: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  /**
   * Saves a board's columns, its hooks, and the schedules that tidy it as a
   * template. Replaces a saved template with the same name.
   */
  Schema.Struct({
    type: Schema.Literal("template.save"),
    boardId: Id,
    name: TrimmedNonEmptyString,
    description: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("template.delete"), templateId: Id }),
]);
export type TemplatesCommand = typeof TemplatesCommand.Type;

/** The board or template a command made; null for deletes. */
export const TemplatesCommandResult = Schema.Struct({ id: Schema.NullOr(Schema.String) });
export type TemplatesCommandResult = typeof TemplatesCommandResult.Type;

export const ForkTemplatesSubscribeRpc = Rpc.make(FORK_TEMPLATES_WS_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: TemplatesSnapshot,
  error: Schema.Union([BoardsCommandError, EnvironmentAuthorizationError]),
  stream: true,
});

export const ForkTemplatesDispatchRpc = Rpc.make(FORK_TEMPLATES_WS_METHODS.dispatch, {
  payload: TemplatesCommand,
  success: TemplatesCommandResult,
  error: Schema.Union([BoardsCommandError, EnvironmentAuthorizationError]),
});
