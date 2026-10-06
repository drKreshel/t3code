/**
 * Chat pins (fork): each thread's note and pinned artifacts, live from the
 * thread's own environment.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  FORK_THREAD_PINS_WS_METHODS,
  type ScopedThreadRef,
  ThreadId,
  type ThreadPins,
  type ThreadPinsCommand,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback } from "react";

import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "./use-atom-command";

const scheduler = createAtomCommandScheduler();

const threadPinsEnvironment = {
  subscribe: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "fork:thread-pins:subscribe",
    tag: FORK_THREAD_PINS_WS_METHODS.subscribe,
  }),
  // Serial per thread: an unpin followed by a note edit must land in order.
  dispatch: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:thread-pins:dispatch",
    tag: FORK_THREAD_PINS_WS_METHODS.dispatch,
    scheduler,
    concurrency: {
      mode: "serial",
      key: ({ environmentId, input }) => `${environmentId}:${input.threadId}`,
    },
  }),
};

const threadPinsAtom = Atom.family((key: string) => {
  const separator = key.indexOf("\u0000");
  const environmentId = key.slice(0, separator) as EnvironmentId;
  const threadId = ThreadId.make(key.slice(separator + 1));
  return Atom.make((get): ThreadPins | null => {
    const result = get(threadPinsEnvironment.subscribe({ environmentId, input: { threadId } }));
    return Option.getOrNull(AsyncResult.value(result));
  }).pipe(Atom.withLabel(`fork-thread-pins:${threadId}`));
});
const NO_PINS_ATOM = Atom.make<ThreadPins | null>(null).pipe(
  Atom.withLabel("fork-thread-pins:none"),
);

/** A chat's note and pins, live. Null while loading or when the server lacks them. */
export function useThreadPins(threadRef: ScopedThreadRef | null): ThreadPins | null {
  return useAtomValue(
    threadRef === null
      ? NO_PINS_ATOM
      : threadPinsAtom(`${threadRef.environmentId}\u0000${threadRef.threadId}`),
  );
}

/** Sends one pins command to the chat's environment; a refused one toasts its reason. */
export function useThreadPinsDispatch(
  environmentId: EnvironmentId,
): (command: ThreadPinsCommand) => Promise<void> {
  const dispatch = useAtomCommand(threadPinsEnvironment.dispatch, { reportFailure: false });
  return useCallback(
    async (command: ThreadPinsCommand) => {
      const result = await dispatch({ environmentId, input: command });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not update chat pins",
        description:
          typeof error === "object" && error !== null && "message" in error
            ? String((error as { readonly message: unknown }).message)
            : "An error occurred.",
      });
    },
    [dispatch, environmentId],
  );
}

/** URLs open as links; anything else is a host file path. */
export const isUrlPinTarget = (target: string) => /^https?:\/\//i.test(target);
