/**
 * Boards and tickets, stored in `fork.sqlite`.
 *
 * Every write goes through `dispatch`, one command at a time, and publishes
 * which tickets it touched; subscribers reload whole snapshots, which stay
 * small (boards and tickets, without comments or events).
 */
import {
  type Board,
  BoardsCommandError,
  type BoardsCommand,
  type BoardsCommandErrorCode,
  type BoardsCommandResult,
  type BoardsSnapshot,
  type ColumnSpec,
  type Ticket,
  type TicketDetail,
  type TicketFlag,
  TicketFlag as TicketFlagSchema,
  type TicketPriority,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ForkDatabase from "../ForkDatabase.ts";

const EventPayloadJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodePayload = Schema.decodeUnknownSync(EventPayloadJson);
const encodePayload = Schema.encodeSync(EventPayloadJson);

/** `user` for people; `thread:<scoped thread key>` for agents; `automation:<id>` for automations. */
export type BoardsActor = string;

export class BoardsService extends Context.Service<
  BoardsService,
  {
    readonly snapshot: Effect.Effect<BoardsSnapshot, BoardsCommandError>;
    readonly stream: Stream.Stream<BoardsSnapshot, BoardsCommandError>;
    readonly ticketDetailStream: (
      ticketId: string,
    ) => Stream.Stream<TicketDetail, BoardsCommandError>;
    readonly dispatch: (
      command: BoardsCommand,
      actor: BoardsActor,
    ) => Effect.Effect<BoardsCommandResult, BoardsCommandError>;
  }
>()("t3/fork/boards/BoardsService") {}

/** Columns a new board starts with. Names and colors only: columns never start work. */
export const DEFAULT_BOARD_COLUMNS: ReadonlyArray<{
  readonly name: string;
  readonly color: string | null;
}> = [
  { name: "Backlog", color: null },
  { name: "Todo", color: null },
  { name: "In progress", color: "blue" },
  { name: "Review", color: "violet" },
  { name: "Done", color: "green" },
];

const FlagJson = Schema.fromJsonString(TicketFlagSchema);
const decodeFlag = Schema.decodeUnknownSync(FlagJson);
const encodeFlag = Schema.encodeSync(FlagJson);

const fail = (code: BoardsCommandErrorCode, message: string) =>
  Effect.fail(new BoardsCommandError({ code, message }));

const isBoardsCommandError = (error: unknown): error is BoardsCommandError =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly _tag?: unknown })._tag === "BoardsCommandError";

const toCommandError = (error: unknown): BoardsCommandError =>
  isBoardsCommandError(error)
    ? error
    : new BoardsCommandError({
        code: "storage",
        message: error instanceof Error ? error.message : String(error),
      });

interface BoardRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly default_project_key: string | null;
  readonly new_chat_message: string | null;
  readonly position: number;
  readonly ticket_counter: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
}
interface ColumnRow {
  readonly id: string;
  readonly board_id: string;
  readonly name: string;
  readonly color: string | null;
  readonly position: number;
  readonly move_after_days: number | null;
  readonly move_to_column_id: string | null;
}
interface TicketRow {
  readonly id: string;
  readonly board_id: string;
  readonly number: number;
  readonly title: string;
  readonly description: string;
  readonly column_id: string;
  readonly priority: TicketPriority;
  readonly project_key: string | null;
  readonly folder: string | null;
  readonly position: number;
  readonly flag_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const changes = yield* PubSub.unbounded<ReadonlyArray<string>>();
  const writeLock = yield* Semaphore.make(1);

  const newId = crypto.randomUUIDv4;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const loadSnapshot = Effect.gen(function* () {
    const boards = yield* sql<BoardRow>`SELECT * FROM fork_boards ORDER BY position, created_at`;
    const columns = yield* sql<ColumnRow>`SELECT * FROM fork_board_columns ORDER BY position`;
    const tickets = yield* sql<TicketRow>`SELECT * FROM fork_tickets ORDER BY position`;
    const criteria = yield* sql<{
      readonly id: string;
      readonly ticket_id: string;
      readonly text: string;
      readonly checked: number;
      readonly position: number;
    }>`SELECT id, ticket_id, text, checked, position FROM fork_ticket_criteria ORDER BY position`;
    const requires = yield* sql<{
      readonly ticket_id: string;
      readonly requires_ticket_id: string;
    }>`SELECT ticket_id, requires_ticket_id FROM fork_ticket_requires`;
    const threads = yield* sql<{
      readonly ticket_id: string;
      readonly thread_key: string;
    }>`SELECT ticket_id, thread_key FROM fork_ticket_threads ORDER BY linked_at`;

    const group = <Row, Key extends keyof Row>(rows: ReadonlyArray<Row>, key: Key) => {
      const map = new Map<Row[Key], Row[]>();
      for (const row of rows) {
        const list = map.get(row[key]);
        if (list) list.push(row);
        else map.set(row[key], [row]);
      }
      return map;
    };
    const columnsByBoard = group(columns, "board_id");
    const criteriaByTicket = group(criteria, "ticket_id");
    const requiresByTicket = group(requires, "ticket_id");
    const threadsByTicket = group(threads, "ticket_id");

    return {
      boards: boards.map((row): Board => ({
        id: row.id,
        key: row.key,
        name: row.name,
        defaultProjectKey: row.default_project_key,
        newChatMessage: row.new_chat_message,
        position: row.position,
        columns: (columnsByBoard.get(row.id) ?? []).map((column) => ({
          id: column.id,
          name: column.name,
          color: column.color,
          position: column.position,
          autoMove:
            column.move_after_days !== null && column.move_to_column_id !== null
              ? { afterDays: column.move_after_days, toColumnId: column.move_to_column_id }
              : null,
        })),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        archivedAt: row.archived_at,
      })),
      tickets: tickets.map((row): Ticket => ({
        id: row.id,
        boardId: row.board_id,
        number: row.number,
        title: row.title,
        description: row.description,
        columnId: row.column_id,
        priority: row.priority,
        projectKey: row.project_key,
        folder: row.folder,
        position: row.position,
        flag: row.flag_json === null ? null : decodeFlag(row.flag_json),
        requires: (requiresByTicket.get(row.id) ?? []).map((entry) => entry.requires_ticket_id),
        criteria: (criteriaByTicket.get(row.id) ?? []).map((criterion) => ({
          id: criterion.id,
          text: criterion.text,
          checked: criterion.checked === 1,
          position: criterion.position,
        })),
        threadKeys: (threadsByTicket.get(row.id) ?? []).map((entry) => entry.thread_key),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        archivedAt: row.archived_at,
      })),
    } satisfies BoardsSnapshot;
  }).pipe(Effect.mapError(toCommandError));

  const loadTicketDetail = (ticketId: string) =>
    Effect.gen(function* () {
      const comments = yield* sql<{
        readonly id: string;
        readonly ticket_id: string;
        readonly body: string;
        readonly is_handoff: number;
        readonly author: string;
        readonly created_at: string;
        readonly edited_at: string | null;
      }>`SELECT * FROM fork_ticket_comments WHERE ticket_id = ${ticketId} ORDER BY created_at`;
      const events = yield* sql<{
        readonly id: string;
        readonly ticket_id: string;
        readonly kind: string;
        readonly payload_json: string;
        readonly actor: string;
        readonly created_at: string;
      }>`SELECT * FROM fork_ticket_events WHERE ticket_id = ${ticketId} ORDER BY created_at`;
      return {
        ticketId,
        comments: comments.map((row) => ({
          id: row.id,
          ticketId: row.ticket_id,
          body: row.body,
          isHandoff: row.is_handoff === 1,
          author: row.author,
          createdAt: row.created_at,
          editedAt: row.edited_at,
        })),
        events: events.map((row) => ({
          id: row.id,
          ticketId: row.ticket_id,
          kind: row.kind,
          payload: decodePayload(row.payload_json),
          actor: row.actor,
          createdAt: row.created_at,
        })),
      } satisfies TicketDetail;
    }).pipe(Effect.mapError(toCommandError));

  // ---------------------------------------------------------------------------
  // Lookups

  const findBoard = (boardId: string) =>
    sql<BoardRow>`SELECT * FROM fork_boards WHERE id = ${boardId}`.pipe(
      Effect.flatMap((rows) =>
        rows[0] ? Effect.succeed(rows[0]) : fail("not-found", "That board no longer exists."),
      ),
    );
  const findColumn = (columnId: string) =>
    sql<ColumnRow>`SELECT * FROM fork_board_columns WHERE id = ${columnId}`.pipe(
      Effect.flatMap((rows) =>
        rows[0] ? Effect.succeed(rows[0]) : fail("not-found", "That column no longer exists."),
      ),
    );
  const findTicket = (ticketId: string) =>
    sql<TicketRow>`SELECT * FROM fork_tickets WHERE id = ${ticketId}`.pipe(
      Effect.flatMap((rows) =>
        rows[0] ? Effect.succeed(rows[0]) : fail("not-found", "That ticket no longer exists."),
      ),
    );
  const ticketLabel = (ticket: TicketRow) =>
    sql<{ readonly key: string }>`SELECT key FROM fork_boards WHERE id = ${ticket.board_id}`.pipe(
      Effect.map((rows) => `${rows[0]?.key ?? "?"}-${ticket.number}`),
    );

  const setFlag = (ticketId: string, flag: TicketFlag | null) =>
    sql`UPDATE fork_tickets SET flag_json = ${flag === null ? null : encodeFlag(flag)}
      WHERE id = ${ticketId}`;

  const nextPosition = (table: "tickets" | "columns" | "criteria" | "boards", scope: string) => {
    const query =
      table === "tickets"
        ? sql<{ readonly next: number }>`
            SELECT COALESCE(MAX(position), 0) + 1 AS next FROM fork_tickets WHERE column_id = ${scope}`
        : table === "columns"
          ? sql<{ readonly next: number }>`
            SELECT COALESCE(MAX(position), 0) + 1 AS next FROM fork_board_columns WHERE board_id = ${scope}`
          : table === "criteria"
            ? sql<{ readonly next: number }>`
            SELECT COALESCE(MAX(position), 0) + 1 AS next FROM fork_ticket_criteria WHERE ticket_id = ${scope}`
            : sql<{ readonly next: number }>`
            SELECT COALESCE(MAX(position), 0) + 1 AS next FROM fork_boards`;
    return query.pipe(Effect.map((rows) => rows[0]?.next ?? 1));
  };

  const recordEvent = (
    ticketId: string,
    kind: string,
    payload: Record<string, unknown>,
    actor: BoardsActor,
    at: string,
  ) =>
    Effect.gen(function* () {
      const id = yield* newId;
      yield* sql`
        INSERT INTO fork_ticket_events (id, ticket_id, kind, payload_json, actor, created_at)
        VALUES (${id}, ${ticketId}, ${kind}, ${encodePayload(payload)}, ${actor}, ${at})
      `;
    });

  const touchTicket = (ticketId: string, at: string) =>
    sql`UPDATE fork_tickets SET updated_at = ${at} WHERE id = ${ticketId}`;

  /** Would `ticketId` requiring `requiresId` close a loop? */
  const createsCycle = (ticketId: string, requiresId: string) =>
    Effect.gen(function* () {
      if (ticketId === requiresId) return true;
      const edges = yield* sql<{
        readonly ticket_id: string;
        readonly requires_ticket_id: string;
      }>`SELECT ticket_id, requires_ticket_id FROM fork_ticket_requires`;
      const next = new Map<string, string[]>();
      for (const edge of edges) {
        const list = next.get(edge.ticket_id);
        if (list) list.push(edge.requires_ticket_id);
        else next.set(edge.ticket_id, [edge.requires_ticket_id]);
      }
      const seen = new Set<string>();
      const stack = [requiresId];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (current === ticketId) return true;
        if (seen.has(current)) continue;
        seen.add(current);
        stack.push(...(next.get(current) ?? []));
      }
      return false;
    });

  // ---------------------------------------------------------------------------
  // Commands

  const run = (command: BoardsCommand, actor: BoardsActor) =>
    Effect.gen(function* () {
      const at = yield* nowIso;
      switch (command.type) {
        case "board.create": {
          const taken = yield* sql`SELECT id FROM fork_boards WHERE key = ${command.key}`;
          if (taken.length > 0) return yield* fail("key-taken", `Key ${command.key} is taken.`);
          const id = yield* newId;
          const position = yield* nextPosition("boards", "");
          yield* sql`
            INSERT INTO fork_boards (id, key, name, default_project_key, position, created_at, updated_at)
            VALUES (${id}, ${command.key}, ${command.name}, ${command.defaultProjectKey ?? null},
              ${position}, ${at}, ${at})
          `;
          const specs: ReadonlyArray<ColumnSpec> = command.columns ?? DEFAULT_BOARD_COLUMNS;
          const created: Array<{ readonly id: string; readonly spec: ColumnSpec }> = [];
          for (const [index, spec] of specs.entries()) {
            const columnId = yield* newId;
            yield* sql`
              INSERT INTO fork_board_columns (id, board_id, name, color, position)
              VALUES (${columnId}, ${id}, ${spec.name}, ${spec.color}, ${index + 1})
            `;
            created.push({ id: columnId, spec });
          }
          // Specs name their target column; a missing or same column drops the move.
          const sameName = (a: string, b: string) =>
            a.trim().toLowerCase() === b.trim().toLowerCase();
          for (const column of created) {
            const autoMove = column.spec.autoMove;
            if (!autoMove) continue;
            const target = created.find((other) => sameName(other.spec.name, autoMove.toColumn));
            if (!target || target.id === column.id) continue;
            yield* sql`
              UPDATE fork_board_columns
              SET move_after_days = ${autoMove.afterDays}, move_to_column_id = ${target.id}
              WHERE id = ${column.id}
            `;
          }
          return { id, touched: [] };
        }
        case "board.update": {
          const board = yield* findBoard(command.boardId);
          if (command.key !== undefined && command.key !== board.key) {
            const taken = yield* sql`SELECT id FROM fork_boards WHERE key = ${command.key}`;
            if (taken.length > 0) return yield* fail("key-taken", `Key ${command.key} is taken.`);
          }
          yield* sql`
            UPDATE fork_boards SET
              name = ${command.name ?? board.name},
              key = ${command.key ?? board.key},
              default_project_key = ${
                command.defaultProjectKey === undefined
                  ? board.default_project_key
                  : command.defaultProjectKey
              },
              new_chat_message = ${
                command.newChatMessage === undefined
                  ? board.new_chat_message
                  : command.newChatMessage?.trim() || null
              },
              updated_at = ${at}
            WHERE id = ${board.id}
          `;
          return { id: null, touched: [] };
        }
        case "board.archive": {
          const board = yield* findBoard(command.boardId);
          yield* sql`
            UPDATE fork_boards SET archived_at = ${command.archived ? at : null}, updated_at = ${at}
            WHERE id = ${board.id}
          `;
          return { id: null, touched: [] };
        }
        case "board.reorder": {
          const board = yield* findBoard(command.boardId);
          yield* sql`UPDATE fork_boards SET position = ${command.position} WHERE id = ${board.id}`;
          return { id: null, touched: [] };
        }
        case "column.create": {
          const board = yield* findBoard(command.boardId);
          const id = yield* newId;
          const position = yield* nextPosition("columns", board.id);
          yield* sql`
            INSERT INTO fork_board_columns (id, board_id, name, color, position)
            VALUES (${id}, ${board.id}, ${command.name}, ${command.color ?? null}, ${position})
          `;
          return { id, touched: [] };
        }
        case "column.update": {
          const column = yield* findColumn(command.columnId);
          const autoMove = command.autoMove;
          if (autoMove) {
            const target = yield* findColumn(autoMove.toColumnId);
            if (target.board_id !== column.board_id || target.id === column.id) {
              return yield* fail("invalid", "Move tickets to another column of the same board.");
            }
          }
          yield* sql`
            UPDATE fork_board_columns
            SET name = ${command.name ?? column.name},
              color = ${command.color === undefined ? column.color : command.color},
              move_after_days = ${
                autoMove === undefined ? column.move_after_days : (autoMove?.afterDays ?? null)
              },
              move_to_column_id = ${
                autoMove === undefined ? column.move_to_column_id : (autoMove?.toColumnId ?? null)
              }
            WHERE id = ${column.id}
          `;
          return { id: null, touched: [] };
        }
        case "column.delete": {
          const column = yield* findColumn(command.columnId);
          const target = yield* findColumn(command.moveTicketsTo);
          if (target.board_id !== column.board_id || target.id === column.id) {
            return yield* fail("invalid", "Move its tickets to another column of the same board.");
          }
          const moved = yield* sql<{ readonly id: string }>`
            SELECT id FROM fork_tickets WHERE column_id = ${column.id}
          `;
          const base = yield* nextPosition("tickets", target.id);
          for (const [index, ticket] of moved.entries()) {
            yield* sql`
              UPDATE fork_tickets SET column_id = ${target.id}, position = ${base + index},
                updated_at = ${at}
              WHERE id = ${ticket.id}
            `;
            yield* recordEvent(
              ticket.id,
              "moved",
              { from: column.name, to: target.name, reason: "column deleted" },
              actor,
              at,
            );
          }
          yield* sql`
            UPDATE fork_board_columns SET move_after_days = NULL, move_to_column_id = NULL
            WHERE move_to_column_id = ${column.id}
          `;
          yield* sql`DELETE FROM fork_board_columns WHERE id = ${column.id}`;
          return { id: null, touched: moved.map((ticket) => ticket.id) };
        }
        case "column.reorder": {
          const column = yield* findColumn(command.columnId);
          yield* sql`
            UPDATE fork_board_columns SET position = ${command.position} WHERE id = ${column.id}
          `;
          return { id: null, touched: [] };
        }
        case "ticket.create": {
          const board = yield* findBoard(command.boardId);
          const column =
            command.columnId !== undefined
              ? yield* findColumn(command.columnId)
              : ((yield* sql<ColumnRow>`
                  SELECT * FROM fork_board_columns WHERE board_id = ${board.id}
                  ORDER BY position LIMIT 1
                `)[0] ?? (yield* fail("invalid", "The board has no columns.")));
          if (column.board_id !== board.id) {
            return yield* fail("invalid", "That column belongs to another board.");
          }
          for (const requiredId of command.requires ?? []) yield* findTicket(requiredId);
          const number = board.ticket_counter + 1;
          yield* sql`UPDATE fork_boards SET ticket_counter = ${number} WHERE id = ${board.id}`;
          const id = yield* newId;
          const position = yield* nextPosition("tickets", column.id);
          yield* sql`
            INSERT INTO fork_tickets (id, board_id, number, title, description, column_id, priority,
              project_key, folder, position, created_at, updated_at)
            VALUES (${id}, ${board.id}, ${number}, ${command.title}, ${command.description ?? ""},
              ${column.id}, ${command.priority ?? "none"}, ${command.projectKey ?? null},
              ${
                command.folder
                  ?.split("/")
                  .map((name) => name.trim())
                  .join("/") ?? null
              },
              ${position}, ${at}, ${at})
          `;
          for (const [index, text] of (command.criteria ?? []).entries()) {
            const criterionId = yield* newId;
            yield* sql`
              INSERT INTO fork_ticket_criteria (id, ticket_id, text, checked, position, updated_at)
              VALUES (${criterionId}, ${id}, ${text}, 0, ${index + 1}, ${at})
            `;
          }
          for (const requiredId of new Set(command.requires ?? [])) {
            yield* sql`
              INSERT INTO fork_ticket_requires (ticket_id, requires_ticket_id)
              VALUES (${id}, ${requiredId})
            `;
          }
          yield* recordEvent(id, "created", { column: column.name }, actor, at);
          return { id, touched: [id] };
        }
        case "ticket.update": {
          const ticket = yield* findTicket(command.ticketId);
          const folder =
            command.folder === undefined
              ? ticket.folder
              : (command.folder
                  ?.split("/")
                  .map((name) => name.trim())
                  .join("/") ?? null);
          yield* sql`
            UPDATE fork_tickets SET
              title = ${command.title ?? ticket.title},
              description = ${command.description ?? ticket.description},
              priority = ${command.priority ?? ticket.priority},
              project_key = ${command.projectKey === undefined ? ticket.project_key : command.projectKey},
              folder = ${folder},
              updated_at = ${at}
            WHERE id = ${ticket.id}
          `;
          const changed = [
            command.title !== undefined && command.title !== ticket.title ? "title" : null,
            command.description !== undefined && command.description !== ticket.description
              ? "description"
              : null,
            command.priority !== undefined && command.priority !== ticket.priority
              ? "priority"
              : null,
            command.projectKey !== undefined && command.projectKey !== ticket.project_key
              ? "project"
              : null,
            command.folder !== undefined && folder !== ticket.folder ? "folder" : null,
          ].filter((field) => field !== null);
          if (changed.length > 0) {
            yield* recordEvent(
              ticket.id,
              "updated",
              {
                fields: changed,
                ...(command.priority !== undefined ? { priority: command.priority } : {}),
              },
              actor,
              at,
            );
          }
          return { id: null, touched: [ticket.id] };
        }
        case "ticket.move": {
          const ticket = yield* findTicket(command.ticketId);
          const from = yield* findColumn(ticket.column_id);
          const to = yield* findColumn(command.columnId);
          if (to.board_id !== ticket.board_id) {
            return yield* fail("invalid", "That column belongs to another board.");
          }
          const position = command.position ?? (yield* nextPosition("tickets", to.id));
          yield* sql`
            UPDATE fork_tickets SET column_id = ${to.id}, position = ${position}, updated_at = ${at}
            WHERE id = ${ticket.id}
          `;
          if (from.id !== to.id) {
            yield* recordEvent(
              ticket.id,
              "moved",
              { from: from.name, to: to.name, ...(command.quiet ? { quiet: true } : {}) },
              actor,
              at,
            );
            // Organizing the board does not resolve a decision or resume work.
          }
          return { id: null, touched: [ticket.id] };
        }
        case "ticket.flag": {
          const ticket = yield* findTicket(command.ticketId);
          yield* setFlag(ticket.id, {
            level: command.level,
            reason: command.reason,
            by: actor,
            at,
          });
          yield* touchTicket(ticket.id, at);
          yield* recordEvent(
            ticket.id,
            "flagged",
            { level: command.level, reason: command.reason },
            actor,
            at,
          );
          return { id: null, touched: [ticket.id] };
        }
        case "ticket.resolveFlag": {
          const ticket = yield* findTicket(command.ticketId);
          if (ticket.flag_json === null) return { id: null, touched: [] };
          yield* setFlag(ticket.id, null);
          yield* touchTicket(ticket.id, at);
          yield* recordEvent(ticket.id, "flag.resolved", {}, actor, at);
          return { id: null, touched: [ticket.id] };
        }
        case "ticket.archive": {
          const ticket = yield* findTicket(command.ticketId);
          yield* sql`
            UPDATE fork_tickets SET archived_at = ${command.archived ? at : null}, updated_at = ${at}
            WHERE id = ${ticket.id}
          `;
          yield* recordEvent(
            ticket.id,
            command.archived ? "archived" : "unarchived",
            {},
            actor,
            at,
          );
          return { id: null, touched: [ticket.id] };
        }
        case "criterion.add": {
          const ticket = yield* findTicket(command.ticketId);
          const id = yield* newId;
          const position = yield* nextPosition("criteria", ticket.id);
          yield* sql`
            INSERT INTO fork_ticket_criteria (id, ticket_id, text, checked, position, updated_at)
            VALUES (${id}, ${ticket.id}, ${command.text}, 0, ${position}, ${at})
          `;
          yield* touchTicket(ticket.id, at);
          return { id, touched: [ticket.id] };
        }
        case "criterion.update": {
          const rows = yield* sql<{
            readonly ticket_id: string;
            readonly text: string;
            readonly checked: number;
          }>`SELECT ticket_id, text, checked FROM fork_ticket_criteria WHERE id = ${command.criterionId}`;
          const criterion = rows[0];
          if (!criterion) return yield* fail("not-found", "That criterion no longer exists.");
          const checked = command.checked ?? criterion.checked === 1;
          yield* sql`
            UPDATE fork_ticket_criteria
            SET text = ${command.text ?? criterion.text}, checked = ${checked ? 1 : 0},
              updated_at = ${at}
            WHERE id = ${command.criterionId}
          `;
          if (command.checked !== undefined && checked !== (criterion.checked === 1)) {
            yield* recordEvent(
              criterion.ticket_id,
              checked ? "criterion.checked" : "criterion.unchecked",
              { text: command.text ?? criterion.text },
              actor,
              at,
            );
          }
          yield* touchTicket(criterion.ticket_id, at);
          return { id: null, touched: [criterion.ticket_id] };
        }
        case "criterion.delete":
        case "criterion.reorder": {
          const rows = yield* sql<{ readonly ticket_id: string }>`
            SELECT ticket_id FROM fork_ticket_criteria WHERE id = ${command.criterionId}
          `;
          const ticketId = rows[0]?.ticket_id;
          if (!ticketId) return yield* fail("not-found", "That criterion no longer exists.");
          if (command.type === "criterion.delete") {
            yield* sql`DELETE FROM fork_ticket_criteria WHERE id = ${command.criterionId}`;
          } else {
            yield* sql`
              UPDATE fork_ticket_criteria SET position = ${command.position}
              WHERE id = ${command.criterionId}
            `;
          }
          yield* touchTicket(ticketId, at);
          return { id: null, touched: [ticketId] };
        }
        case "requirement.add": {
          const ticket = yield* findTicket(command.ticketId);
          const required = yield* findTicket(command.requiresTicketId);
          if (yield* createsCycle(ticket.id, required.id)) {
            return yield* fail("cycle", "That would make the tickets wait on each other.");
          }
          yield* sql`
            INSERT OR IGNORE INTO fork_ticket_requires (ticket_id, requires_ticket_id)
            VALUES (${ticket.id}, ${required.id})
          `;
          yield* recordEvent(
            ticket.id,
            "requirement.added",
            { ticket: yield* ticketLabel(required) },
            actor,
            at,
          );
          yield* touchTicket(ticket.id, at);
          return { id: null, touched: [ticket.id] };
        }
        case "requirement.remove": {
          const ticket = yield* findTicket(command.ticketId);
          const required = yield* findTicket(command.requiresTicketId);
          yield* sql`
            DELETE FROM fork_ticket_requires
            WHERE ticket_id = ${ticket.id} AND requires_ticket_id = ${required.id}
          `;
          yield* recordEvent(
            ticket.id,
            "requirement.removed",
            { ticket: yield* ticketLabel(required) },
            actor,
            at,
          );
          yield* touchTicket(ticket.id, at);
          return { id: null, touched: [ticket.id] };
        }
        case "comment.add": {
          const ticket = yield* findTicket(command.ticketId);
          const id = yield* newId;
          yield* sql`
            INSERT INTO fork_ticket_comments (id, ticket_id, body, is_handoff, author, created_at)
            VALUES (${id}, ${ticket.id}, ${command.body}, ${command.isHandoff ? 1 : 0}, ${actor},
              ${at})
          `;
          yield* touchTicket(ticket.id, at);
          return { id, touched: [ticket.id] };
        }
        case "comment.update":
        case "comment.delete": {
          const rows = yield* sql<{
            readonly ticket_id: string;
            readonly body: string;
            readonly is_handoff: number;
          }>`SELECT ticket_id, body, is_handoff FROM fork_ticket_comments WHERE id = ${command.commentId}`;
          const comment = rows[0];
          if (!comment) return yield* fail("not-found", "That comment no longer exists.");
          if (command.type === "comment.delete") {
            yield* sql`DELETE FROM fork_ticket_comments WHERE id = ${command.commentId}`;
          } else {
            yield* sql`
              UPDATE fork_ticket_comments
              SET body = ${command.body ?? comment.body},
                is_handoff = ${
                  command.isHandoff === undefined ? comment.is_handoff : command.isHandoff ? 1 : 0
                },
                edited_at = ${command.body !== undefined ? at : null}
              WHERE id = ${command.commentId}
            `;
          }
          return { id: null, touched: [comment.ticket_id] };
        }
        case "thread.link": {
          const previous = yield* sql<{ readonly ticket_id: string }>`
            SELECT ticket_id FROM fork_ticket_threads WHERE thread_key = ${command.threadKey}
          `;
          const previousTicketId = previous[0]?.ticket_id ?? null;
          if (previousTicketId === command.ticketId) return { id: null, touched: [] };
          const touched: string[] = [];
          if (previousTicketId !== null) {
            yield* sql`DELETE FROM fork_ticket_threads WHERE thread_key = ${command.threadKey}`;
            yield* recordEvent(
              previousTicketId,
              "thread.unlinked",
              { threadKey: command.threadKey },
              actor,
              at,
            );
            touched.push(previousTicketId);
          }
          if (command.ticketId !== null) {
            const ticket = yield* findTicket(command.ticketId);
            yield* sql`
              INSERT INTO fork_ticket_threads (thread_key, ticket_id, source, linked_at)
              VALUES (${command.threadKey}, ${ticket.id}, ${actor === "user" ? "manual" : actor},
                ${at})
            `;
            yield* recordEvent(
              ticket.id,
              "thread.linked",
              { threadKey: command.threadKey },
              actor,
              at,
            );
            touched.push(ticket.id);
          }
          return { id: null, touched };
        }
      }
    });

  const dispatch = (command: BoardsCommand, actor: BoardsActor) =>
    Effect.gen(function* () {
      const result = yield* writeLock.withPermits(1)(sql.withTransaction(run(command, actor)));
      yield* PubSub.publish(changes, result.touched);
      return { id: result.id } satisfies BoardsCommandResult;
    }).pipe(Effect.mapError(toCommandError));

  // One-slot sliding mailbox per subscriber: snapshots are whole states, so a
  // slow socket skipping intermediate ones is safe.
  const stream = Stream.callback<BoardsSnapshot, BoardsCommandError>(
    (mailbox) =>
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        Queue.offerUnsafe(mailbox, yield* loadSnapshot);
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach(() =>
            loadSnapshot.pipe(
              Effect.matchEffect({
                onFailure: (error) => Queue.fail(mailbox, error),
                onSuccess: (snapshot) => Effect.sync(() => Queue.offerUnsafe(mailbox, snapshot)),
              }),
            ),
          ),
          Effect.forkScoped,
        );
      }),
    { bufferSize: 1, strategy: "sliding" },
  );

  const ticketDetailStream = (ticketId: string) =>
    Stream.callback<TicketDetail, BoardsCommandError>(
      (mailbox) =>
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          Queue.offerUnsafe(mailbox, yield* loadTicketDetail(ticketId));
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((touched) => touched.includes(ticketId)),
            Stream.runForEach(() =>
              loadTicketDetail(ticketId).pipe(
                Effect.matchEffect({
                  onFailure: (error) => Queue.fail(mailbox, error),
                  onSuccess: (detail) => Effect.sync(() => Queue.offerUnsafe(mailbox, detail)),
                }),
              ),
            ),
            Effect.forkScoped,
          );
        }),
      { bufferSize: 1, strategy: "sliding" },
    );

  return BoardsService.of({
    snapshot: loadSnapshot,
    stream,
    ticketDetailStream,
    dispatch,
  });
});

/** Uses its own `fork.sqlite` client; the runtime's main database is not visible here. */
export const layer = Layer.effect(BoardsService, make).pipe(Layer.provide(ForkDatabase.layer));

/** In-memory variant for tests. */
export const layerMemory = Layer.effect(BoardsService, make).pipe(
  Layer.provide(ForkDatabase.ForkDatabaseMemory),
);
