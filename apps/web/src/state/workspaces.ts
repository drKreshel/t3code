/**
 * Ticket workspaces (fork). They live on the primary environment's server,
 * like boards, so every hook here reads that environment.
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
  FORK_WORKSPACES_WS_METHODS,
  type ProjectRepos,
  type TicketWorkspace,
  type WorkspaceRules,
  type WorkspaceScope,
  type WorkspacesCommand,
  type WorkspacesCommandResult,
  type WorkspacesSnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { usePrimaryEnvironmentId } from "./environments";
import { useAtomCommand } from "./use-atom-command";

const scheduler = createAtomCommandScheduler();

const workspacesEnvironment = {
  snapshot: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "fork:workspaces:snapshot",
    tag: FORK_WORKSPACES_WS_METHODS.subscribe,
  }),
  dispatch: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:workspaces:dispatch",
    tag: FORK_WORKSPACES_WS_METHODS.dispatch,
    scheduler,
    concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
  }),
  listRepos: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:workspaces:list-repos",
    tag: FORK_WORKSPACES_WS_METHODS.listRepos,
    scheduler,
  }),
};

const EMPTY: WorkspacesSnapshot = { rules: [], workspaces: [] };

const workspacesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): WorkspacesSnapshot => {
    const result = get(workspacesEnvironment.snapshot({ environmentId, input: {} }));
    return Option.getOrElse(AsyncResult.value(result), () => EMPTY);
  }).pipe(Atom.withLabel(`fork-workspaces:${environmentId}`)),
);
const NO_ENVIRONMENT_ATOM = Atom.make<WorkspacesSnapshot>(EMPTY).pipe(
  Atom.withLabel("fork-workspaces:no-environment"),
);

/** Every workspace rule layer and ticket workspace, live. Empty while loading. */
export function useWorkspaces(): WorkspacesSnapshot {
  const environmentId = usePrimaryEnvironmentId();
  return useAtomValue(environmentId === null ? NO_ENVIRONMENT_ATOM : workspacesAtom(environmentId));
}

/** The rules one layer sets, or undefined when it sets none. */
export function rulesOf(
  snapshot: WorkspacesSnapshot,
  scope: WorkspaceScope,
  scopeId: string | null,
): WorkspaceRules | undefined {
  if (scopeId === null) return undefined;
  return snapshot.rules.find((rules) => rules.scope === scope && rules.scopeId === scopeId);
}

/** The ticket's current (not removed) workspace, or null. */
export function workspaceOf(
  snapshot: WorkspacesSnapshot,
  ticketId: string,
): TicketWorkspace | null {
  return (
    snapshot.workspaces.find(
      (workspace) => workspace.ticketId === ticketId && workspace.removedAt === null,
    ) ?? null
  );
}

function errorMessage(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { readonly message: unknown }).message)
    : "An error occurred.";
}

/**
 * Sends one workspace command. Resolves with the result, or undefined when
 * refused; a refusal toasts unless `quiet` (the caller shows it itself).
 */
export function useWorkspacesDispatch(): (
  command: WorkspacesCommand,
  options?: { readonly quiet?: boolean },
) => Promise<
  | { readonly ok: true; readonly result: WorkspacesCommandResult }
  | { readonly ok: false; readonly code: string | null; readonly message: string }
  | undefined
> {
  const environmentId = usePrimaryEnvironmentId();
  const dispatch = useAtomCommand(workspacesEnvironment.dispatch, { reportFailure: false });
  return useCallback(
    async (command, options) => {
      if (environmentId === null) return undefined;
      const result = await dispatch({ environmentId, input: command });
      if (result._tag === "Success") return { ok: true, result: result.value };
      if (isAtomCommandInterrupted(result)) return undefined;
      const error = squashAtomCommandFailure(result);
      const message = errorMessage(error);
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { readonly code: unknown }).code)
          : null;
      if (!options?.quiet) {
        toastManager.add({ type: "error", title: "Workspace change failed", description: message });
      }
      return { ok: false, code, message };
    },
    [dispatch, environmentId],
  );
}

/** What a project folder is and the repos in it; null while loading or unknown. */
export function useProjectRepos(projectKey: string | null): ProjectRepos | null {
  const environmentId = usePrimaryEnvironmentId();
  const listRepos = useAtomCommand(workspacesEnvironment.listRepos, { reportFailure: false });
  const [repos, setRepos] = useState<{ readonly key: string; readonly value: ProjectRepos } | null>(
    null,
  );
  useEffect(() => {
    if (environmentId === null || projectKey === null) return;
    let cancelled = false;
    void listRepos({ environmentId, input: { projectKey } }).then((result) => {
      if (!cancelled && result._tag === "Success") {
        setRepos({ key: projectKey, value: result.value });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, listRepos, projectKey]);
  return repos !== null && repos.key === projectKey ? repos.value : null;
}
