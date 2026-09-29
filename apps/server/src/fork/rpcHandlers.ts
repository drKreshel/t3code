/**
 * WebSocket handlers for fork RPCs, spread into `WsRpcGroup.of({...})` in
 * `ws.ts`. The observers are ws.ts's own, so fork methods get the same
 * authorization and tracing as upstream ones.
 */
import {
  BoardsCommandError,
  type BoardsCommand,
  type EnvironmentAuthorizationError,
  FORK_BOARDS_WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { BoardsService } from "./boards/BoardsService.ts";

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

const unavailable = new BoardsCommandError({
  code: "storage",
  message: "Boards are not available on this server.",
});
const unavailableBoards: BoardsService["Service"] = {
  snapshot: Effect.fail(unavailable),
  stream: Stream.fail(unavailable),
  ticketDetailStream: () => Stream.fail(unavailable),
  dispatch: () => Effect.fail(unavailable),
};

export const makeForkRpcHandlers = ({ observeRpcEffect, observeRpcStream }: RpcObservers) =>
  Effect.gen(function* () {
    // Optional so runtimes that do not provide fork services (upstream's own
    // server tests) still build; there, fork methods report unavailability.
    const maybeBoards = yield* Effect.serviceOption(BoardsService);
    const boards = Option.getOrElse(maybeBoards, () => unavailableBoards);
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
    };
  });
