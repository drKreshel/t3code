/**
 * Boards and tickets (fork). They live on the primary environment's server,
 * so every hook here reads that environment.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  squashAtomCommandFailure,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import {
  FORK_BOARDS_WS_METHODS,
  type BoardsCommand,
  type BoardsSnapshot,
  type EnvironmentId,
  type TicketDetail,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { usePrimaryEnvironmentId } from "./environments";
import { useAtomCommand } from "./use-atom-command";

const scheduler = createAtomCommandScheduler();

export const boardsEnvironment = {
  snapshot: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "fork:boards:snapshot",
    tag: FORK_BOARDS_WS_METHODS.subscribe,
  }),
  ticketDetail: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "fork:boards:ticket-detail",
    tag: FORK_BOARDS_WS_METHODS.subscribeTicket,
  }),
  // Serial per environment: a quick drag followed by an edit must land in order.
  dispatch: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:boards:dispatch",
    tag: FORK_BOARDS_WS_METHODS.dispatch,
    scheduler,
    concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
  }),
};

export type BoardsState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly snapshot: BoardsSnapshot };

const LOADING: BoardsState = { status: "loading" };
const UNAVAILABLE: BoardsState = { status: "unavailable" };

const boardsStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): BoardsState => {
    const result = get(boardsEnvironment.snapshot({ environmentId, input: {} }));
    if (AsyncResult.isFailure(result)) return UNAVAILABLE;
    return Option.match(AsyncResult.value(result), {
      onNone: () => LOADING,
      onSome: (snapshot) => ({ status: "ready", snapshot }),
    });
  }).pipe(Atom.withLabel(`fork-boards:${environmentId}`)),
);
const NO_ENVIRONMENT_ATOM = Atom.make<BoardsState>(LOADING).pipe(
  Atom.withLabel("fork-boards:no-environment"),
);

/** Every board and ticket, live. */
export function useBoards(): BoardsState {
  const environmentId = usePrimaryEnvironmentId();
  return useAtomValue(
    environmentId === null ? NO_ENVIRONMENT_ATOM : boardsStateAtom(environmentId),
  );
}

const ticketDetailAtom = Atom.family((key: string) => {
  const separator = key.indexOf("\u0000");
  const environmentId = key.slice(0, separator) as EnvironmentId;
  const ticketId = key.slice(separator + 1);
  return Atom.make((get): TicketDetail | null => {
    const result = get(boardsEnvironment.ticketDetail({ environmentId, input: { ticketId } }));
    return Option.getOrNull(AsyncResult.value(result));
  }).pipe(Atom.withLabel(`fork-ticket-detail:${ticketId}`));
});
const NO_DETAIL_ATOM = Atom.make<TicketDetail | null>(null).pipe(
  Atom.withLabel("fork-ticket-detail:none"),
);

/** A ticket's comments and timeline, live. Null while loading. */
export function useTicketDetail(ticketId: string | null): TicketDetail | null {
  const environmentId = usePrimaryEnvironmentId();
  return useAtomValue(
    environmentId === null || ticketId === null
      ? NO_DETAIL_ATOM
      : ticketDetailAtom(`${environmentId}\u0000${ticketId}`),
  );
}

/**
 * Sends one board command to the primary environment. Resolves with the id a
 * create command made (or null); a refused command toasts its reason and
 * resolves undefined.
 */
export function useBoardsDispatch(): (
  command: BoardsCommand,
) => Promise<string | null | undefined> {
  const environmentId = usePrimaryEnvironmentId();
  const dispatch = useAtomCommand(boardsEnvironment.dispatch, { reportFailure: false });
  return useCallback(
    async (command: BoardsCommand) => {
      if (environmentId === null) return undefined;
      const result = await dispatch({ environmentId, input: command });
      if (result._tag === "Success") return result.value.id;
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Board change failed",
          description:
            typeof error === "object" && error !== null && "message" in error
              ? String((error as { readonly message: unknown }).message)
              : "An error occurred.",
        });
      }
      return undefined;
    },
    [dispatch, environmentId],
  );
}
