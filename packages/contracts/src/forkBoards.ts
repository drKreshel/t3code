/**
 * Boards and tickets (fork feature). Boards live on the environment's own
 * server in a separate `fork.sqlite`, so this contract is independent of the
 * orchestration model.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { TicketWorkflow } from "./forkAutomations.ts";

export const FORK_BOARDS_WS_METHODS = {
  subscribe: "fork.boards.subscribe",
  subscribeTicket: "fork.boards.subscribeTicket",
  dispatch: "fork.boards.dispatch",
} as const;

/**
 * A ticket waiting on a person. `warning` (yellow): an agent asked for help or
 * execution was paused. `error` (red): a run failed. Resolving a flag does not
 * resume execution; Start / Resume is explicit.
 */
export const TicketFlag = Schema.Struct({
  level: Schema.Literals(["warning", "error"]),
  reason: Schema.String,
  /** `user`, `thread:<key>`, or `automation:<id>`. */
  by: Schema.String,
  at: IsoDateTime,
});
export type TicketFlag = typeof TicketFlag.Type;

export const TicketPriority = Schema.Literals(["none", "low", "medium", "high", "urgent"]);
export type TicketPriority = typeof TicketPriority.Type;

/** Sidebar folder names separated by `/`, independent of filesystem paths. */
export const TicketFolderPath = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(?=[^/]*[^\s/])[^/]+(?:\/(?=[^/]*[^\s/])[^/]+)*$/),
);

/** Two to five capital letters or digits, starting with a letter: `WEB`, `API2`. */
export const BoardKey = TrimmedNonEmptyString.check(Schema.isPattern(/^[A-Z][A-Z0-9]{1,4}$/));

/** A column records progress; moving a ticket does not execute its workflow. */
export const BoardColumn = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  /** A color token for the column's dot, like `blue`; null for the neutral one. */
  color: Schema.NullOr(Schema.String),
  position: Schema.Number,
});
export type BoardColumn = typeof BoardColumn.Type;

/** A column to create: a new board's, or a template's. */
export const ColumnSpec = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.NullOr(Schema.String),
});
export type ColumnSpec = typeof ColumnSpec.Type;

export const Board = Schema.Struct({
  id: TrimmedNonEmptyString,
  key: BoardKey,
  name: TrimmedNonEmptyString,
  /** Scoped project key (`environmentId:projectId`) new chats start in. */
  defaultProjectKey: Schema.NullOr(Schema.String),
  position: Schema.Number,
  columns: Schema.Array(BoardColumn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type Board = typeof Board.Type;

export const TicketCriterion = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  checked: Schema.Boolean,
  position: Schema.Number,
});
export type TicketCriterion = typeof TicketCriterion.Type;

export const Ticket = Schema.Struct({
  id: TrimmedNonEmptyString,
  boardId: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  description: Schema.String,
  columnId: TrimmedNonEmptyString,
  priority: TicketPriority,
  /** Overrides the board's default project for new chats. */
  projectKey: Schema.NullOr(Schema.String),
  /** Creates this folder hierarchy in each client and files linked chats there. */
  folder: Schema.optional(Schema.NullOr(TicketFolderPath)),
  workflow: Schema.optional(Schema.NullOr(TicketWorkflow)),
  /** The durable chat that owns execution; resumed instead of replaced. */
  workflowThreadKey: Schema.optional(Schema.NullOr(Schema.String)),
  position: Schema.Number,
  flag: Schema.NullOr(TicketFlag),
  /**
   * Tickets this one depends on. A link only: T3 attaches no rule to it; people,
   * agents, and workflow instructions read the required tickets' columns and decide.
   */
  requires: Schema.Array(TrimmedNonEmptyString),
  criteria: Schema.Array(TicketCriterion),
  /** Scoped thread keys (`environmentId:threadId`) linked to this ticket. */
  threadKeys: Schema.Array(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type Ticket = typeof Ticket.Type;

/** Every board and ticket; streamed whole, since both stay small. */
export const BoardsSnapshot = Schema.Struct({
  boards: Schema.Array(Board),
  tickets: Schema.Array(Ticket),
});
export type BoardsSnapshot = typeof BoardsSnapshot.Type;

export const TicketComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  ticketId: TrimmedNonEmptyString,
  body: Schema.String,
  /** The note for the next chat; the latest one goes into chat briefings. */
  isHandoff: Schema.Boolean,
  /** `user`, or `thread:<scoped thread key>` for an agent. */
  author: Schema.String,
  createdAt: IsoDateTime,
  editedAt: Schema.NullOr(IsoDateTime),
});
export type TicketComment = typeof TicketComment.Type;

export const TicketEvent = Schema.Struct({
  id: TrimmedNonEmptyString,
  ticketId: TrimmedNonEmptyString,
  kind: Schema.String,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  actor: Schema.String,
  createdAt: IsoDateTime,
});
export type TicketEvent = typeof TicketEvent.Type;

export const TicketDetail = Schema.Struct({
  ticketId: TrimmedNonEmptyString,
  comments: Schema.Array(TicketComment),
  events: Schema.Array(TicketEvent),
});
export type TicketDetail = typeof TicketDetail.Type;

const command = <Type extends string, Fields extends Schema.Struct.Fields>(
  type: Type,
  fields: Fields,
) => Schema.Struct({ type: Schema.Literal(type), ...fields });

const Id = TrimmedNonEmptyString;

export const BoardsCommand = Schema.Union([
  command("board.create", {
    name: TrimmedNonEmptyString,
    key: BoardKey,
    defaultProjectKey: Schema.optional(Schema.NullOr(Schema.String)),
    /** Omitted: the default columns. */
    columns: Schema.optional(Schema.Array(ColumnSpec)),
  }),
  command("board.update", {
    boardId: Id,
    name: Schema.optional(TrimmedNonEmptyString),
    key: Schema.optional(BoardKey),
    defaultProjectKey: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  command("board.archive", { boardId: Id, archived: Schema.Boolean }),
  command("board.reorder", { boardId: Id, position: Schema.Number }),
  command("column.create", {
    boardId: Id,
    name: TrimmedNonEmptyString,
    color: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  command("column.update", {
    columnId: Id,
    name: Schema.optional(TrimmedNonEmptyString),
    color: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  command("column.delete", { columnId: Id, moveTicketsTo: Id }),
  command("column.reorder", { columnId: Id, position: Schema.Number }),
  command("ticket.create", {
    boardId: Id,
    title: TrimmedNonEmptyString,
    description: Schema.optional(Schema.String),
    columnId: Schema.optional(Id),
    priority: Schema.optional(TicketPriority),
    projectKey: Schema.optional(Schema.NullOr(Schema.String)),
    folder: Schema.optional(Schema.NullOr(TicketFolderPath)),
    workflow: Schema.optional(Schema.NullOr(TicketWorkflow)),
    criteria: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    requires: Schema.optional(Schema.Array(Id)),
  }),
  command("ticket.update", {
    ticketId: Id,
    title: Schema.optional(TrimmedNonEmptyString),
    description: Schema.optional(Schema.String),
    priority: Schema.optional(TicketPriority),
    projectKey: Schema.optional(Schema.NullOr(Schema.String)),
    folder: Schema.optional(Schema.NullOr(TicketFolderPath)),
    workflow: Schema.optional(Schema.NullOr(TicketWorkflow)),
  }),
  command("ticket.workflowSession", {
    ticketId: Id,
    threadKey: Schema.NullOr(TrimmedNonEmptyString),
    event: Schema.Literals(["started", "resumed", "paused", "finished", "failed"]),
    reason: Schema.optional(Schema.String),
  }),
  command("ticket.move", {
    ticketId: Id,
    columnId: Id,
    /** Omitted: the end of the column. */
    position: Schema.optional(Schema.Number),
    /** Legacy organizing marker; all moves preserve flags and never start work. */
    quiet: Schema.optional(Schema.Boolean),
  }),
  /** Raises (or replaces) the ticket's flag. */
  command("ticket.flag", {
    ticketId: Id,
    level: TicketFlag.fields.level,
    reason: TrimmedNonEmptyString,
  }),
  command("ticket.resolveFlag", { ticketId: Id }),
  command("ticket.archive", { ticketId: Id, archived: Schema.Boolean }),
  command("criterion.add", { ticketId: Id, text: TrimmedNonEmptyString }),
  command("criterion.update", {
    criterionId: Id,
    text: Schema.optional(TrimmedNonEmptyString),
    checked: Schema.optional(Schema.Boolean),
  }),
  command("criterion.delete", { criterionId: Id }),
  command("criterion.reorder", { criterionId: Id, position: Schema.Number }),
  command("requirement.add", { ticketId: Id, requiresTicketId: Id }),
  command("requirement.remove", { ticketId: Id, requiresTicketId: Id }),
  command("comment.add", {
    ticketId: Id,
    body: TrimmedNonEmptyString,
    isHandoff: Schema.optional(Schema.Boolean),
  }),
  command("comment.update", {
    commentId: Id,
    body: Schema.optional(TrimmedNonEmptyString),
    isHandoff: Schema.optional(Schema.Boolean),
  }),
  command("comment.delete", { commentId: Id }),
  /** Links a chat to a ticket (a chat has at most one); null unlinks. */
  command("thread.link", { threadKey: TrimmedNonEmptyString, ticketId: Schema.NullOr(Id) }),
]);
export type BoardsCommand = typeof BoardsCommand.Type;

/** The id a create command made; null for other commands. */
export const BoardsCommandResult = Schema.Struct({ id: Schema.NullOr(Schema.String) });
export type BoardsCommandResult = typeof BoardsCommandResult.Type;

export const BoardsCommandErrorCode = Schema.Literals([
  "not-found",
  "key-taken",
  "blocked",
  "cycle",
  "invalid",
  "storage",
]);
export type BoardsCommandErrorCode = typeof BoardsCommandErrorCode.Type;

export class BoardsCommandError extends Schema.TaggedError<BoardsCommandError>()(
  "BoardsCommandError",
  {
    code: BoardsCommandErrorCode,
    message: Schema.String,
  },
) {}

export const ForkBoardsSubscribeRpc = Rpc.make(FORK_BOARDS_WS_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: BoardsSnapshot,
  error: Schema.Union([BoardsCommandError, EnvironmentAuthorizationError]),
  stream: true,
});

export const ForkBoardsSubscribeTicketRpc = Rpc.make(FORK_BOARDS_WS_METHODS.subscribeTicket, {
  payload: Schema.Struct({ ticketId: TrimmedNonEmptyString }),
  success: TicketDetail,
  error: Schema.Union([BoardsCommandError, EnvironmentAuthorizationError]),
  stream: true,
});

export const ForkBoardsDispatchRpc = Rpc.make(FORK_BOARDS_WS_METHODS.dispatch, {
  payload: BoardsCommand,
  success: BoardsCommandResult,
  error: Schema.Union([BoardsCommandError, EnvironmentAuthorizationError]),
});
