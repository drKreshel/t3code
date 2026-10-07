/**
 * Folders scheduled tasks file their runs' chats into (fork). They live on the
 * primary environment's server, like boards, so every hook here reads that
 * environment.
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
  FORK_TASK_FOLDERS_WS_METHODS,
  type SetTaskFolderInput,
  type TaskFolderRoute,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback } from "react";

import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { usePrimaryEnvironmentId } from "./environments";
import { useAtomCommand } from "./use-atom-command";

const scheduler = createAtomCommandScheduler();

const taskFoldersEnvironment = {
  snapshot: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "fork:task-folders:snapshot",
    tag: FORK_TASK_FOLDERS_WS_METHODS.subscribe,
  }),
  set: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:task-folders:set",
    tag: FORK_TASK_FOLDERS_WS_METHODS.set,
    scheduler,
    concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
  }),
};

/** `loading` until the first snapshot; `unavailable` when the server has no task folders. */
export type TaskFoldersState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly routes: ReadonlyArray<TaskFolderRoute> };

const LOADING: TaskFoldersState = { status: "loading" };

const taskFoldersAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): TaskFoldersState => {
    const result = get(taskFoldersEnvironment.snapshot({ environmentId, input: {} }));
    if (AsyncResult.isSuccess(result)) return { status: "ready", routes: result.value.routes };
    return AsyncResult.isFailure(result) ? { status: "unavailable" } : LOADING;
  }).pipe(Atom.withLabel(`fork-task-folders:${environmentId}`)),
);
const NO_ENVIRONMENT_ATOM = Atom.make<TaskFoldersState>(LOADING).pipe(
  Atom.withLabel("fork-task-folders:no-environment"),
);

export function useTaskFolders(): TaskFoldersState {
  const environmentId = usePrimaryEnvironmentId();
  return useAtomValue(
    environmentId === null ? NO_ENVIRONMENT_ATOM : taskFoldersAtom(environmentId),
  );
}

/** Sets or clears a task's folder. Resolves false when refused (toasted). */
export function useSetTaskFolder(): (input: SetTaskFolderInput) => Promise<boolean> {
  const environmentId = usePrimaryEnvironmentId();
  const set = useAtomCommand(taskFoldersEnvironment.set, { reportFailure: false });
  return useCallback(
    async (input: SetTaskFolderInput) => {
      if (environmentId === null) return false;
      const result = await set({ environmentId, input });
      if (result._tag === "Success") return true;
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not change the folder",
          description:
            typeof error === "object" && error !== null && "message" in error
              ? String((error as { readonly message: unknown }).message)
              : "An error occurred.",
        });
      }
      return false;
    },
    [environmentId, set],
  );
}
