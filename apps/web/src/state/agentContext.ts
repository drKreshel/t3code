/**
 * Agent context (fork): what a thread's agent receives that the chat does not
 * show. Read on demand from the thread's own environment.
 */
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  FORK_AGENT_CONTEXT_WS_METHODS,
  type ScopedThreadRef,
  type ServerProvider,
  type ThreadAgentContext,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

const scheduler = createAtomCommandScheduler();

const agentContextEnvironment = {
  thread: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:agent-context:thread",
    tag: FORK_AGENT_CONTEXT_WS_METHODS.thread,
    scheduler,
  }),
};

export type AgentContextState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly context: ThreadAgentContext };

/** The thread's agent context, read when the panel opens and on `reload`. */
export function useThreadAgentContext(threadRef: ScopedThreadRef): {
  readonly state: AgentContextState;
  readonly reload: () => void;
} {
  const read = useAtomCommand(agentContextEnvironment.thread, { reportFailure: false });
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    readonly key: string;
    readonly value: AgentContextState;
  } | null>(null);
  const key = `${threadRef.environmentId}:${threadRef.threadId}:${revision}`;
  useEffect(() => {
    let cancelled = false;
    void read({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }).then((result) => {
      if (cancelled) return;
      setState({
        key,
        value:
          result._tag === "Success"
            ? { status: "ready", context: result.value }
            : { status: "error", message: "The agent context could not be read." },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [key, read, threadRef.environmentId, threadRef.threadId]);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  return { state: state?.key === key ? state.value : { status: "loading" }, reload };
}

/**
 * Asks the server to scan a provider's skills for a folder when the provider
 * snapshot has none for it yet, like the composer does for its `$` picker.
 */
export function useProviderWorkspaceSkillsScan(
  threadRef: ScopedThreadRef,
  provider: ServerProvider | null,
  cwd: string | null,
): void {
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const hasSnapshot =
    cwd !== null && provider?.workspaceSnapshots?.some((snapshot) => snapshot.cwd === cwd);
  const instanceId = provider?.instanceId ?? null;
  useEffect(() => {
    if (cwd === null || instanceId === null || hasSnapshot) return;
    void refreshProviders({
      environmentId: threadRef.environmentId,
      input: { instanceId, cwd },
    });
  }, [cwd, hasSnapshot, instanceId, refreshProviders, threadRef.environmentId]);
}
