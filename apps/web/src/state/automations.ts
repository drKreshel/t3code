/**
 * Automations (fork). Like boards, they live on the primary environment's
 * server, so every hook here reads that environment.
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
  type AutomationsCommand,
  type AutomationsSnapshot,
  type EnvironmentId,
  FORK_AUTOMATIONS_WS_METHODS,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { usePrimaryEnvironmentId } from "./environments";
import { useAtomCommand } from "./use-atom-command";

const scheduler = createAtomCommandScheduler();

const automationsEnvironment = {
  snapshot: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "fork:automations:snapshot",
    tag: FORK_AUTOMATIONS_WS_METHODS.subscribe,
  }),
  dispatch: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:automations:dispatch",
    tag: FORK_AUTOMATIONS_WS_METHODS.dispatch,
    scheduler,
    concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
  }),
};

export type AutomationsState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly snapshot: AutomationsSnapshot };

const LOADING: AutomationsState = { status: "loading" };
const UNAVAILABLE: AutomationsState = { status: "unavailable" };

const automationsStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): AutomationsState => {
    const result = get(automationsEnvironment.snapshot({ environmentId, input: {} }));
    if (AsyncResult.isFailure(result)) return UNAVAILABLE;
    return Option.match(AsyncResult.value(result), {
      onNone: () => LOADING,
      onSome: (snapshot) => ({ status: "ready", snapshot }),
    });
  }).pipe(Atom.withLabel(`fork-automations:${environmentId}`)),
);
const NO_ENVIRONMENT_ATOM = Atom.make<AutomationsState>(LOADING).pipe(
  Atom.withLabel("fork-automations:no-environment"),
);

/** Every automation, recent runs, and paused boards, live. */
export function useAutomations(): AutomationsState {
  const environmentId = usePrimaryEnvironmentId();
  return useAtomValue(
    environmentId === null ? NO_ENVIRONMENT_ATOM : automationsStateAtom(environmentId),
  );
}

/**
 * Sends one automations command to the primary environment. Resolves with the
 * id a create command made (or null); a refused command toasts its reason and
 * resolves undefined.
 */
export function useAutomationsDispatch(): (
  command: AutomationsCommand,
) => Promise<string | null | undefined> {
  const environmentId = usePrimaryEnvironmentId();
  const dispatch = useAtomCommand(automationsEnvironment.dispatch, { reportFailure: false });
  return useCallback(
    async (command: AutomationsCommand) => {
      if (environmentId === null) return undefined;
      const result = await dispatch({ environmentId, input: command });
      if (result._tag === "Success") return result.value.id;
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Automation change failed",
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
