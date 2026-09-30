/**
 * WebSocket handlers for fork RPCs, spread into `WsRpcGroup.of({...})` in
 * `ws.ts`. The observers are ws.ts's own, so fork methods get the same
 * authorization and tracing as upstream ones.
 */
import {
  AutomationsCommandError,
  type AutomationsCommand,
  BoardsCommandError,
  type BoardsCommand,
  FORK_AUTOMATIONS_WS_METHODS,
  type EnvironmentAuthorizationError,
  FORK_BOARDS_WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { AutomationEngine } from "./automations/AutomationEngine.ts";
import { AutomationsStore } from "./automations/AutomationsStore.ts";
import { type BoardEvent, BoardsService } from "./boards/BoardsService.ts";

interface RpcObservers {
  readonly observeRpcEffect: <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;
  readonly observeRpcStream: <A, E, R>(
    method: string,
    stream: Stream.Stream<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Stream.Stream<A, E | EnvironmentAuthorizationError, R>;
}

const TRACE = { "rpc.aggregate": "fork-boards" } as const;
const AUTOMATIONS_TRACE = { "rpc.aggregate": "fork-automations" } as const;

const automationsUnavailable = new AutomationsCommandError({
  code: "storage",
  message: "Automations are not available on this server.",
});

const unavailable = new BoardsCommandError({
  code: "storage",
  message: "Boards are not available on this server.",
});
/** Stands in where the runtime does not provide BoardsService, such as upstream's server tests. */
export const unavailableBoards: BoardsService["Service"] = {
  snapshot: Effect.fail(unavailable),
  stream: Stream.fail(unavailable),
  ticketDetailStream: () => Stream.fail(unavailable),
  dispatch: () => Effect.fail(unavailable),
  subscribeEvents: PubSub.unbounded<BoardEvent>().pipe(Effect.flatMap(PubSub.subscribe)),
};

export const makeForkRpcHandlers = ({ observeRpcEffect, observeRpcStream }: RpcObservers) =>
  Effect.gen(function* () {
    // Optional so runtimes that do not provide fork services (upstream's own
    // server tests) still build; there, fork methods report unavailability.
    const maybeBoards = yield* Effect.serviceOption(BoardsService);
    const boards = Option.getOrElse(maybeBoards, () => unavailableBoards);
    const automationsStore = yield* Effect.serviceOption(AutomationsStore);
    const automationEngine = yield* Effect.serviceOption(AutomationEngine);
    return {
      [FORK_BOARDS_WS_METHODS.subscribe]: () =>
        observeRpcStream(FORK_BOARDS_WS_METHODS.subscribe, boards.stream, TRACE),
      [FORK_BOARDS_WS_METHODS.subscribeTicket]: (input: { readonly ticketId: string }) =>
        observeRpcStream(
          FORK_BOARDS_WS_METHODS.subscribeTicket,
          boards.ticketDetailStream(input.ticketId),
          TRACE,
        ),
      [FORK_BOARDS_WS_METHODS.dispatch]: (command: BoardsCommand) =>
        observeRpcEffect(FORK_BOARDS_WS_METHODS.dispatch, boards.dispatch(command, "user"), TRACE),
      [FORK_AUTOMATIONS_WS_METHODS.subscribe]: () =>
        observeRpcStream(
          FORK_AUTOMATIONS_WS_METHODS.subscribe,
          Option.match(automationsStore, {
            onNone: () => Stream.fail(automationsUnavailable),
            onSome: (store) => store.stream,
          }),
          AUTOMATIONS_TRACE,
        ),
      [FORK_AUTOMATIONS_WS_METHODS.dispatch]: (command: AutomationsCommand) =>
        observeRpcEffect(
          FORK_AUTOMATIONS_WS_METHODS.dispatch,
          Option.match(automationEngine, {
            onNone: () => Effect.fail(automationsUnavailable),
            onSome: (engine) => engine.dispatch(command),
          }),
          AUTOMATIONS_TRACE,
        ),
    };
  });
