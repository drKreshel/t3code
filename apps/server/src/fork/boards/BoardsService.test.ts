import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { BoardColumnType, BoardsCommand, BoardsSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { BoardsService, layerMemory } from "./BoardsService.ts";

const TestLayer = layerMemory.pipe(Layer.provide(NodeServices.layer));

const dispatch = (command: BoardsCommand, actor = "user") =>
  Effect.gen(function* () {
    const boards = yield* BoardsService;
    return yield* boards.dispatch(command, actor);
  });
const snapshot = Effect.gen(function* () {
  const boards = yield* BoardsService;
  return yield* boards.snapshot;
});

const createdId = (command: BoardsCommand) =>
  dispatch(command).pipe(Effect.map((result) => result.id!));

const columnOfType = (state: BoardsSnapshot, boardId: string, type: BoardColumnType) =>
  state.boards.find((board) => board.id === boardId)!.columns.find((c) => c.type === type)!.id;

/** The first ticket detail the stream sends: its current comments and events. */
const ticketDetail = (ticketId: string) =>
  Effect.gen(function* () {
    const boards = yield* BoardsService;
    const details = yield* boards
      .ticketDetailStream(ticketId)
      .pipe(Stream.take(1), Stream.runCollect);
    return [...details][0]!;
  });

// Tests share one database, so each uses its own board key.
const setupBoard = (key: string) =>
  Effect.gen(function* () {
    const boardId = yield* createdId({ type: "board.create", name: key, key });
    const state = yield* snapshot;
    return {
      boardId,
      todo: columnOfType(state, boardId, "todo"),
      active: columnOfType(state, boardId, "active"),
      attention: columnOfType(state, boardId, "attention"),
      done: columnOfType(state, boardId, "done"),
    };
  });

it.layer(TestLayer)("BoardsService", (it) => {
  it.effect("creates boards with the default typed columns and unique keys", () =>
    Effect.gen(function* () {
      const { boardId } = yield* setupBoard("WEB");
      const board = (yield* snapshot).boards.find((entry) => entry.id === boardId)!;
      assert.deepEqual(
        board.columns.map((column) => column.type),
        ["backlog", "todo", "active", "review", "attention", "done"],
      );
      const error = yield* Effect.flip(dispatch({ type: "board.create", name: "Dup", key: "WEB" }));
      assert.equal(error.code, "key-taken");
    }),
  );

  it.effect("numbers tickets per board and starts them in the backlog", () =>
    Effect.gen(function* () {
      const boardId = yield* createdId({ type: "board.create", name: "Api", key: "API" });
      const first = yield* createdId({ type: "ticket.create", boardId, title: "One" });
      const second = yield* createdId({ type: "ticket.create", boardId, title: "Two" });
      const state = yield* snapshot;
      const byId = new Map(state.tickets.map((ticket) => [ticket.id, ticket]));
      assert.equal(byId.get(first)!.number, 1);
      assert.equal(byId.get(second)!.number, 2);
      assert.equal(byId.get(first)!.columnId, columnOfType(state, boardId, "backlog"));
    }),
  );

  it.effect("blocks starting a ticket until what it requires is done", () =>
    Effect.gen(function* () {
      const { boardId, active, done } = yield* setupBoard("OPS");
      const base = yield* createdId({ type: "ticket.create", boardId, title: "Base" });
      const dependent = yield* createdId({
        type: "ticket.create",
        boardId,
        title: "Dependent",
        requires: [base],
      });

      const blocked = yield* Effect.flip(
        dispatch({ type: "ticket.move", ticketId: dependent, columnId: active }),
      );
      assert.equal(blocked.code, "blocked");

      // Agents cannot override; people can, after confirming.
      const agentOverride = yield* Effect.flip(
        dispatch(
          { type: "ticket.move", ticketId: dependent, columnId: active, overrideBlocked: true },
          "thread:env:agent",
        ),
      );
      assert.equal(agentOverride.code, "blocked");

      yield* dispatch({ type: "ticket.move", ticketId: base, columnId: done });
      yield* dispatch({ type: "ticket.move", ticketId: dependent, columnId: active });
      const moved = (yield* snapshot).tickets.find((ticket) => ticket.id === dependent)!;
      assert.equal(moved.columnId, active);

      const detail = yield* ticketDetail(dependent);
      assert.ok(detail.events.some((event) => event.kind === "unblocked"));
    }),
  );

  it.effect("rejects requirements that would wait on each other", () =>
    Effect.gen(function* () {
      const boardId = yield* createdId({ type: "board.create", name: "Loop", key: "LOOP" });
      const a = yield* createdId({ type: "ticket.create", boardId, title: "A" });
      const b = yield* createdId({ type: "ticket.create", boardId, title: "B", requires: [a] });
      const c = yield* createdId({ type: "ticket.create", boardId, title: "C", requires: [b] });
      const error = yield* Effect.flip(
        dispatch({ type: "requirement.add", ticketId: a, requiresTicketId: c }),
      );
      assert.equal(error.code, "cycle");
    }),
  );

  it.effect("keeps an attention reason only while the ticket needs you", () =>
    Effect.gen(function* () {
      const boardId = yield* createdId({ type: "board.create", name: "Help", key: "HELP" });
      const state = yield* snapshot;
      const attention = columnOfType(state, boardId, "attention");
      const todo = columnOfType(state, boardId, "todo");
      const ticket = yield* createdId({ type: "ticket.create", boardId, title: "Stuck" });
      yield* dispatch({
        type: "ticket.move",
        ticketId: ticket,
        columnId: attention,
        reason: "Which API version?",
      });
      const find = Effect.map(snapshot, (next) => next.tickets.find((t) => t.id === ticket)!);
      assert.equal((yield* find).attentionReason, "Which API version?");
      yield* dispatch({ type: "ticket.move", ticketId: ticket, columnId: todo });
      assert.equal((yield* find).attentionReason, null);
    }),
  );

  it.effect("links a chat to one ticket at a time", () =>
    Effect.gen(function* () {
      const boardId = yield* createdId({ type: "board.create", name: "Link", key: "LNK" });
      const first = yield* createdId({ type: "ticket.create", boardId, title: "First" });
      const second = yield* createdId({ type: "ticket.create", boardId, title: "Second" });
      const threadKey = "env-1:thread-1";
      yield* dispatch({ type: "thread.link", threadKey, ticketId: first });
      yield* dispatch({ type: "thread.link", threadKey, ticketId: second });
      const tickets = new Map((yield* snapshot).tickets.map((t) => [t.id, t]));
      assert.deepEqual(tickets.get(first)!.threadKeys, []);
      assert.deepEqual(tickets.get(second)!.threadKeys, [threadKey]);
      yield* dispatch({ type: "thread.link", threadKey, ticketId: null });
      const after = (yield* snapshot).tickets.find((t) => t.id === second)!;
      assert.deepEqual(after.threadKeys, []);
    }),
  );

  it.effect("moves a deleted column's tickets to another column of the board", () =>
    Effect.gen(function* () {
      const boardId = yield* createdId({ type: "board.create", name: "Cols", key: "COLS" });
      const state = yield* snapshot;
      const todo = columnOfType(state, boardId, "todo");
      const backlog = columnOfType(state, boardId, "backlog");
      const ticket = yield* createdId({
        type: "ticket.create",
        boardId,
        title: "Keep me",
        columnId: todo,
      });
      yield* dispatch({ type: "column.delete", columnId: todo, moveTicketsTo: backlog });
      const next = yield* snapshot;
      assert.equal(next.tickets.find((t) => t.id === ticket)!.columnId, backlog);
      assert.notOk(
        next.boards.find((b) => b.id === boardId)!.columns.some((column) => column.id === todo),
      );
    }),
  );
});
