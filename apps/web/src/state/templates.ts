/**
 * Board templates (fork). They live on the primary environment's server, like
 * boards, so every hook here reads that environment.
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
  type BoardTemplate,
  type EnvironmentId,
  FORK_TEMPLATES_WS_METHODS,
  type TemplatesCommand,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback } from "react";

import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { usePrimaryEnvironmentId } from "./environments";
import { useAtomCommand } from "./use-atom-command";

const scheduler = createAtomCommandScheduler();

const templatesEnvironment = {
  snapshot: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "fork:templates:snapshot",
    tag: FORK_TEMPLATES_WS_METHODS.subscribe,
  }),
  dispatch: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:templates:dispatch",
    tag: FORK_TEMPLATES_WS_METHODS.dispatch,
    scheduler,
    concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
  }),
};

const EMPTY: ReadonlyArray<BoardTemplate> = [];

const templatesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<BoardTemplate> => {
    const result = get(templatesEnvironment.snapshot({ environmentId, input: {} }));
    return Option.match(AsyncResult.value(result), {
      onNone: () => EMPTY,
      onSome: (snapshot) => snapshot.templates,
    });
  }).pipe(Atom.withLabel(`fork-templates:${environmentId}`)),
);
const NO_ENVIRONMENT_ATOM = Atom.make<ReadonlyArray<BoardTemplate>>(EMPTY).pipe(
  Atom.withLabel("fork-templates:no-environment"),
);

/** Built-in templates, then saved ones. Empty while loading. */
export function useBoardTemplates(): ReadonlyArray<BoardTemplate> {
  const environmentId = usePrimaryEnvironmentId();
  return useAtomValue(environmentId === null ? NO_ENVIRONMENT_ATOM : templatesAtom(environmentId));
}

/** Sends one template command. Resolves with the id it made, or undefined when refused (toasted). */
export function useTemplatesDispatch(): (
  command: TemplatesCommand,
) => Promise<string | null | undefined> {
  const environmentId = usePrimaryEnvironmentId();
  const dispatch = useAtomCommand(templatesEnvironment.dispatch, { reportFailure: false });
  return useCallback(
    async (command: TemplatesCommand) => {
      if (environmentId === null) return undefined;
      const result = await dispatch({ environmentId, input: command });
      if (result._tag === "Success") return result.value.id;
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Template change failed",
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
