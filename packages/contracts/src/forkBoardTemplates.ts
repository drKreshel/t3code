/**
 * Board templates (fork feature): columns, including when tickets move on by
 * themselves. Creating a board from one copies them; the board is then
 * independent of the template. Built-in templates ship with T3; saved ones
 * live in the environment's `fork.sqlite`.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BoardKey, BoardsCommandError, ColumnSpec } from "./forkBoards.ts";

export const FORK_TEMPLATES_WS_METHODS = {
  subscribe: "fork.templates.subscribe",
  dispatch: "fork.templates.dispatch",
} as const;

export const BoardTemplate = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.String,
  /** Ships with T3; cannot be deleted. */
  builtIn: Schema.Boolean,
  columns: Schema.Array(ColumnSpec),
});
export type BoardTemplate = typeof BoardTemplate.Type;

/** Built-in templates first, then saved ones by name. */
export const TemplatesSnapshot = Schema.Struct({ templates: Schema.Array(BoardTemplate) });
export type TemplatesSnapshot = typeof TemplatesSnapshot.Type;

const Id = TrimmedNonEmptyString;

export const TemplatesCommand = Schema.Union([
  /** Creates a board with the template's columns. */
  Schema.Struct({
    type: Schema.Literal("board.create"),
    templateId: Id,
    name: TrimmedNonEmptyString,
    key: BoardKey,
    defaultProjectKey: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  /** Saves a board's columns as a template. Replaces a saved template with the same name. */
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
