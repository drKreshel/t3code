import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { BoardsCommand, BoardsSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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

const columnNamed = (state: BoardsSnapshot, boardId: string, name: string) =>
  state.boards.find((board) => board.id === boardId)!.columns.find((c) => c.name === name)!.id;

it.layer(TestLayer)("BoardsService", (it) => {
  it.effect(
    "persists a ticket folder, preserves it on other edits, and records reassignment and clearing",
    () =>
      Effect.gen(function* () {
        const boardId = yield* createdId({ type: "board.create", name: "Salones", key: "SALON" });
        const ticketId = yield* createdId({
          type: "ticket.create",
          boardId,
          title: "Kids venues",
          folder: "SalonesDeFiestas / salones-infantiles",
        });
        const read = snapshot.pipe(
          Effect.map((state) => state.tickets.find((ticket) => ticket.id === ticketId)!),
        );
        assert.equal((yield* read).folder, "SalonesDeFiestas/salones-infantiles");
        yield* dispatch({
          type: "ticket.update",
          ticketId,
          folder: "SalonesDeFiestas / salones-infantiles",
        });
        yield* dispatch({ type: "ticket.update", ticketId, title: "Finish kids venues" });
        assert.equal((yield* read).folder, "SalonesDeFiestas/salones-infantiles");
        yield* dispatch({ type: "ticket.update", ticketId, folder: "SalonesDeFiestas / venues" });
        assert.equal((yield* read).folder, "SalonesDeFiestas/venues");
        yield* dispatch({ type: "ticket.update", ticketId, folder: null });
        assert.equal((yield* read).folder, null);
        const boards = yield* BoardsService;
        const detail = Option.getOrThrow(
          yield* Stream.runHead(boards.ticketDetailStream(ticketId)),
        );
        assert.deepEqual(
          detail.events
            .filter((event) => event.kind === "updated")
            .map((event) => event.payload.fields),
          [["title"], ["folder"], ["folder"]],
        );
      }),
  );
  it.effect("creates boards with plain default columns and unique keys", () =>
    Effect.gen(function* () {
      const boardId = yield* createdId({ type: "board.create", name: "Web", key: "WEB" });
      const board = (yield* snapshot).boards.find((entry) => entry.id === boardId)!;
      assert.deepEqual(
        board.columns.map((column) => column.name),
        ["Backlog", "Todo", "In progress", "Review", "Done"],
      );
      const error = yield* Effect.flip(dispatch({ type: "board.create", name: "Dup", key: "WEB" }));
      assert.equal(error.code, "key-taken");
    }),
  );

  it.effect("keeps a board's new chat message through other edits and clears it when blank", () =>
    Effect.gen(function* () {
      const boardId = yield* createdId({ type: "board.create", name: "Docs", key: "DOCS" });
      const read = snapshot.pipe(
        Effect.map((state) => state.boards.find((board) => board.id === boardId)!.newChatMessage),
      );
      assert.equal(yield* read, null);
      yield* dispatch({ type: "board.update", boardId, newChatMessage: " Implement {key} " });
      yield* dispatch({ type: "board.update", boardId, name: "Documentation" });
      assert.equal(yield* read, "Implement {key}");
      yield* dispatch({ type: "board.update", boardId, newChatMessage: "  " });
      assert.equal(yield* read, null);
    }),
  );

  it.effect("numbers tickets per board and starts them in the first column", () =>
    Effect.gen(function* () {
      const boardId = yield* createdId({ type: "board.create", name: "Api", key: "API" });
      const first = yield* createdId({ type: "ticket.create", boardId, title: "One" });
      const second = yield* createdId({ type: "ticket.create", boardId, title: "Two" });
      const state = yield* snapshot;
      const byId = new Map(state.tickets.map((ticket) => [ticket.id, ticket]));
      assert.equal(byId.get(first)!.number, 1);
      assert.equal(byId.get(second)!.number, 2);
      assert.equal(byId.get(first)!.columnId, columnNamed(state, boardId, "Backlog"));
    }),
  );

  it.effect("keeps requirements as links and moves tickets freely", () =>
    Effect.gen(function* () {
      const boardId = yield* createdId({ type: "board.create", name: "Ops", key: "OPS" });
      const active = columnNamed(yield* snapshot, boardId, "In progress");
      const base = yield* createdId({ type: "ticket.create", boardId, title: "Base" });
      const dependent = yield* createdId({
        type: "ticket.create",
        boardId,
        title: "Dependent",
        requires: [base],
      });
      yield* dispatch({ type: "ticket.move", ticketId: dependent, columnId: active });
      const moved = (yield* snapshot).tickets.find((ticket) => ticket.id === dependent)!;
      assert.equal(moved.columnId, active);
      assert.deepEqual(moved.requires, [base]);
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

  it.effect("keeps a flag through column moves until explicitly resolved", () =>
    Effect.gen(function* () {
      const boardId = yield* createdId({ type: "board.create", name: "Help", key: "HELP" });
      const todo = columnNamed(yield* snapshot, boardId, "Todo");
      const ticket = yield* createdId({ type: "ticket.create", boardId, title: "Stuck" });
      const find = Effect.map(snapshot, (next) => next.tickets.find((t) => t.id === ticket)!);
      yield* dispatch(
        { type: "ticket.flag", ticketId: ticket, level: "warning", reason: "Which API version?" },
        "thread:env:agent",
      );
      assert.deepInclude((yield* find).flag, {
        level: "warning",
        reason: "Which API version?",
        by: "thread:env:agent",
      });
      // Organizing the board does not resolve the decision for either actor.
      yield* dispatch({ type: "ticket.move", ticketId: ticket, columnId: todo }, "automation:a");
      assert.ok((yield* find).flag);
      const backlog = columnNamed(yield* snapshot, boardId, "Backlog");
      yield* dispatch({ type: "ticket.move", ticketId: ticket, columnId: backlog });
      assert.ok((yield* find).flag);

      yield* dispatch({
        type: "ticket.flag",
        ticketId: ticket,
        level: "error",
        reason: "Run failed",
      });
      yield* dispatch({ type: "ticket.resolveFlag", ticketId: ticket });
      assert.equal((yield* find).flag, null);
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
      const todo = columnNamed(state, boardId, "Todo");
      const backlog = columnNamed(state, boardId, "Backlog");
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
