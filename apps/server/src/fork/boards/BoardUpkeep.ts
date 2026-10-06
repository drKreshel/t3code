/**
 * Keeps boards in step with chats and time: files chats another chat started
 * or briefed under that chat's ticket, unlinks deleted chats, hands legacy
 * ticket blockers to the chat that raised them, and moves tickets on from
 * columns that set `autoMove`.
 */
import {
  CommandId,
  type BoardsSnapshot,
  type OrchestrationV2DomainEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../../serverActivation.ts";
import { BoardsService } from "./BoardsService.ts";

const UPKEEP_TICK = "20 seconds";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Ticket timeline actor for moves the board makes by itself. */
export const BOARD_ACTOR = "board";

export class BoardUpkeep extends Context.Service<
  BoardUpkeep,
  {
    /** What the background loop calls per event; tests call it directly. */
    readonly handleDomainEvent: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly tick: Effect.Effect<void>;
  }
>()("t3/fork/boards/BoardUpkeep") {}

/** Tickets due to move on: unchanged in an `autoMove` column for its days. */
export function dueAutoMoves(
  snapshot: BoardsSnapshot,
  nowMs: number,
): ReadonlyArray<{ readonly ticketId: string; readonly columnId: string }> {
  const moves: Array<{ readonly ticketId: string; readonly columnId: string }> = [];
  for (const board of snapshot.boards) {
    if (board.archivedAt !== null) continue;
    for (const column of board.columns) {
      const autoMove = column.autoMove;
      if (!autoMove) continue;
      if (!board.columns.some((other) => other.id === autoMove.toColumnId)) continue;
      const cutoff = nowMs - autoMove.afterDays * DAY_MS;
      for (const ticket of snapshot.tickets) {
        if (ticket.columnId !== column.id || ticket.archivedAt !== null) continue;
        if (DateTime.toEpochMillis(DateTime.makeUnsafe(ticket.updatedAt)) > cutoff) continue;
        moves.push({ ticketId: ticket.id, columnId: autoMove.toColumnId });
      }
    }
  }
  return moves;
}

const make = (options: { readonly background: boolean }) =>
  Effect.gen(function* () {
    const boards = yield* BoardsService;
    const orchestration = yield* Orchestrator.OrchestratorV2;
    const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
    const lock = yield* Semaphore.make(1);
    const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect);

    const logged = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => Effect.logWarning(`Board ${label} failed`, { cause })),
      );

    /** Carry ticket blockers into the chat that raised them. */
    const moveTicketBlockers = Effect.gen(function* () {
      for (const ticket of (yield* boards.snapshot).tickets) {
        const flag = ticket.flag;
        if (flag?.level !== "warning" || ticket.archivedAt !== null) continue;
        if (flag.reason === "Workflow paused. Resume when ready.") {
          yield* boards.dispatch({ type: "ticket.resolveFlag", ticketId: ticket.id }, "system");
          continue;
        }
        const key = flag.by.startsWith("thread:") ? flag.by.slice(7) : null;
        if (!key?.startsWith(`${environmentId}:`)) continue;
        const threadId = ThreadId.make(key.slice(key.indexOf(":") + 1));
        const shell = yield* orchestration.getThreadShell(threadId);
        if (!shell || shell.archivedAt !== null) continue;
        yield* orchestration.dispatch({
          type: "thread.request-human",
          commandId: CommandId.make(`legacy-ticket-blocker:${ticket.id}:${flag.at}`),
          threadId,
          reason: flag.reason,
        });
        yield* boards.dispatch({ type: "ticket.resolveFlag", ticketId: ticket.id }, "system");
      }
    });

    const autoMoveTickets = Effect.gen(function* () {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      for (const move of dueAutoMoves(yield* boards.snapshot, nowMs)) {
        yield* boards.dispatch(
          { type: "ticket.move", ticketId: move.ticketId, columnId: move.columnId },
          BOARD_ACTOR,
        );
      }
    });

    const tick = logged(
      "upkeep",
      serialized(
        Effect.gen(function* () {
          yield* moveTicketBlockers;
          yield* autoMoveTickets;
        }),
      ),
    );

    /** Files a chat another chat started or briefed under that chat's ticket. */
    const linkToParentTicket = (childThreadId: string, parentThreadId: string) => {
      const parentKey = `${environmentId}:${parentThreadId}`;
      const childKey = `${environmentId}:${childThreadId}`;
      return logged(
        "child chat linking",
        serialized(
          Effect.gen(function* () {
            const snapshot = yield* boards.snapshot;
            // A chat already on a ticket stays there.
            if (snapshot.tickets.some((candidate) => candidate.threadKeys.includes(childKey)))
              return;
            const ticket = snapshot.tickets.find((candidate) =>
              candidate.threadKeys.includes(parentKey),
            );
            if (!ticket) return;
            yield* boards.dispatch(
              { type: "thread.link", ticketId: ticket.id, threadKey: childKey },
              `thread:${parentKey}`,
            );
          }),
        ),
      );
    };

    /** A deleted chat leaves its ticket. */
    const unlinkDeleted = (threadKey: string) =>
      Effect.gen(function* () {
        const ticket = (yield* boards.snapshot).tickets.find((candidate) =>
          candidate.threadKeys.includes(threadKey),
        );
        if (!ticket) return;
        yield* boards.dispatch({ type: "thread.link", threadKey, ticketId: null }, "system");
      });

    const handleDomainEvent = (event: OrchestrationV2DomainEvent) => {
      // Subagents, delegated tasks, and forks.
      if (event.type === "thread.created" && event.payload.lineage.parentThreadId !== null) {
        return linkToParentTicket(event.threadId, event.payload.lineage.parentThreadId);
      }
      if (event.type === "turn-item.updated") {
        const item = event.payload;
        // Chats an agent started with create_threads.
        if (item.type === "thread_created")
          return linkToParentTicket(item.targetThreadId, event.threadId);
        // Chats an agent launched or messaged (t3_thread_launch, t3_thread_send).
        if (item.type === "user_message" && item.senderThreadId !== undefined)
          return linkToParentTicket(event.threadId, item.senderThreadId);
      }
      if (event.type === "thread.deleted") {
        return logged(
          "chat deletion",
          serialized(unlinkDeleted(`${environmentId}:${event.threadId}`)),
        );
      }
      return Effect.void;
    };

    if (options.background) {
      const domainEvents = orchestration.streamDomainEvents;
      yield* forkParked(
        Effect.gen(function* () {
          yield* Effect.forkScoped(tick.pipe(Effect.repeat(Schedule.spaced(UPKEEP_TICK))));
          yield* Stream.runForEach(domainEvents, handleDomainEvent);
        }),
      );
    }

    return BoardUpkeep.of({ handleDomainEvent, tick });
  });

export const layer = Layer.effect(BoardUpkeep, make({ background: true }));

/** Without the background loops; tests drive the handlers themselves. */
export const layerManual = Layer.effect(BoardUpkeep, make({ background: false }));
