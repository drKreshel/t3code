import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { BoardsService, layerMemory as boardsLayerMemory } from "./BoardsService.ts";
import { BOARD_ACTOR, BoardUpkeep, layerManual } from "./BoardUpkeep.ts";

const ENVIRONMENT_ID = EnvironmentId.make("env-1");

/** Upkeep over in-memory boards; orchestration records commands and knows only `threads`. */
const makeHarness = (threads: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    const fakes = Layer.mergeAll(
      Layer.mock(OrchestratorV2)({
        dispatch: (command) =>
          Ref.update(commands, (list) => [...list, command]).pipe(
            Effect.as({ sequence: 1, storedEvents: [] }),
          ),
        streamDomainEvents: Stream.empty,
        getThreadShell: (threadId) =>
          Effect.succeed(
            threads.includes(threadId)
              ? ({ id: threadId, archivedAt: null } as OrchestrationV2ThreadShell)
              : null,
          ),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
      }),
    );
    const upkeep = yield* BoardUpkeep.pipe(Effect.provide(layerManual.pipe(Layer.provide(fakes))));
    const boards = yield* BoardsService;
    const boardId = (yield* boards.dispatch(
      { type: "board.create", name: "Atlas", key: "ATLAS" },
      "user",
    )).id!;
    const column = (name: string) =>
      boards.snapshot.pipe(
        Effect.map(
          (snapshot) =>
            snapshot.boards[0]!.columns.find((candidate) => candidate.name === name)!.id,
        ),
      );
    const ticket = (title: string) =>
      boards
        .dispatch({ type: "ticket.create", boardId, title }, "user")
        .pipe(Effect.map((result) => result.id!));
    const linkChat = (ticketId: string, threadId: string) =>
      boards.dispatch(
        { type: "thread.link", ticketId, threadKey: `${ENVIRONMENT_ID}:${threadId}` },
        "user",
      );
    const event = (value: unknown) => upkeep.handleDomainEvent(value as OrchestrationV2DomainEvent);
    return { upkeep, boards, commands, column, ticket, linkChat, event };
  });

const TestLayer = boardsLayerMemory.pipe(Layer.provideMerge(NodeServices.layer));

describe("BoardUpkeep", () => {
  it.effect("moves tickets left in an auto-move column for its days, once due", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const done = yield* harness.column("Done");
      const backlog = yield* harness.column("Backlog");
      const ticketId = yield* harness.ticket("Old news");
      yield* harness.boards.dispatch({ type: "ticket.move", ticketId, columnId: done }, "user");
      yield* harness.boards.dispatch(
        { type: "column.update", columnId: done, autoMove: { afterDays: 2, toColumnId: backlog } },
        "user",
      );
      const columnOfTicket = harness.boards.snapshot.pipe(
        Effect.map((snapshot) => snapshot.tickets[0]!.columnId),
      );

      yield* TestClock.adjust("1 day");
      yield* harness.upkeep.tick;
      expect(yield* columnOfTicket).toBe(done);

      yield* TestClock.adjust("1 day");
      yield* harness.upkeep.tick;
      expect(yield* columnOfTicket).toBe(backlog);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "refuses an auto-move into the same column, and forgets one into a deleted column",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const done = yield* harness.column("Done");
        const review = yield* harness.column("Review");
        const self = yield* harness.boards
          .dispatch(
            { type: "column.update", columnId: done, autoMove: { afterDays: 1, toColumnId: done } },
            "user",
          )
          .pipe(Effect.flip);
        expect(self.code).toBe("invalid");

        yield* harness.boards.dispatch(
          { type: "column.update", columnId: done, autoMove: { afterDays: 1, toColumnId: review } },
          "user",
        );
        yield* harness.boards.dispatch(
          { type: "column.delete", columnId: review, moveTicketsTo: done },
          "user",
        );
        const columns = (yield* harness.boards.snapshot).boards[0]!.columns;
        expect(columns.find((column) => column.id === done)?.autoMove).toBeNull();
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("records the board as the mover on the ticket's timeline", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const done = yield* harness.column("Done");
      const backlog = yield* harness.column("Backlog");
      const ticketId = yield* harness.ticket("Old news");
      yield* harness.boards.dispatch({ type: "ticket.move", ticketId, columnId: done }, "user");
      yield* harness.boards.dispatch(
        { type: "column.update", columnId: done, autoMove: { afterDays: 1, toColumnId: backlog } },
        "user",
      );
      yield* TestClock.adjust("2 days");
      yield* harness.upkeep.tick;
      const detail = yield* harness.boards
        .ticketDetailStream(ticketId)
        .pipe(Stream.take(1), Stream.runHead);
      const moves =
        detail._tag === "Some" ? detail.value.events.filter((e) => e.kind === "moved") : [];
      expect(moves.at(-1)).toMatchObject({ actor: BOARD_ACTOR, payload: { to: "Backlog" } });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("unlinks a deleted chat from its ticket", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const ticketId = yield* harness.ticket("Audit follow-up");
      yield* harness.linkChat(ticketId, "gone");
      yield* harness.event({ type: "thread.deleted", threadId: ThreadId.make("gone") });
      expect((yield* harness.boards.snapshot).tickets[0]?.threadKeys).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("moves a legacy ticket blocker to the chat that raised it, once", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(["worker"]);
      const ticketId = yield* harness.ticket("Blocked migration");
      const threadKey = `${ENVIRONMENT_ID}:worker`;
      yield* harness.linkChat(ticketId, "worker");
      yield* harness.boards.dispatch(
        { type: "ticket.flag", ticketId, level: "warning", reason: "Choose the account." },
        `thread:${threadKey}`,
      );
      yield* harness.upkeep.tick;
      yield* harness.upkeep.tick;
      expect((yield* harness.boards.snapshot).tickets[0]).toMatchObject({
        flag: null,
        threadKeys: [threadKey],
      });
      expect(
        (yield* Ref.get(harness.commands)).filter(
          (command) => command.type === "thread.request-human",
        ),
      ).toEqual([expect.objectContaining({ threadId: "worker", reason: "Choose the account." })]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "links chats a ticket chat delegates, starts, or briefs, but never another ticket's",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const ticketId = yield* harness.ticket("Feature");
        const otherTicketId = yield* harness.ticket("Other feature");
        yield* harness.linkChat(ticketId, "parent");
        yield* harness.linkChat(otherTicketId, "other-ticket-chat");
        const turnItem = (threadId: string, payload: Record<string, unknown>) =>
          harness.event({ type: "turn-item.updated", threadId, payload });
        // Subagents and delegated tasks carry their parent in the lineage.
        yield* harness.event({
          type: "thread.created",
          threadId: "review-child",
          payload: { lineage: { parentThreadId: "parent" } },
        });
        yield* harness.event({
          type: "thread.created",
          threadId: "stray-child",
          payload: { lineage: { parentThreadId: "unlinked-parent" } },
        });
        // create_threads records the new chat in the parent's timeline.
        yield* turnItem("parent", { type: "thread_created", targetThreadId: "created-chat" });
        // t3_thread_launch and t3_thread_send deliver a message from the parent.
        yield* turnItem("launched-chat", { type: "user_message", senderThreadId: "parent" });
        yield* turnItem("other-ticket-chat", { type: "user_message", senderThreadId: "parent" });
        yield* turnItem("own-chat", { type: "user_message" });
        const [linked, other] = (yield* harness.boards.snapshot).tickets.toSorted(
          (a, b) => a.number - b.number,
        );
        expect(linked?.threadKeys.toSorted()).toEqual(
          ["created-chat", "launched-chat", "parent", "review-child"].map(
            (id) => `${ENVIRONMENT_ID}:${id}`,
          ),
        );
        expect(other?.threadKeys).toEqual([`${ENVIRONMENT_ID}:other-ticket-chat`]);
      }).pipe(Effect.provide(TestLayer)),
  );
});
