import {
  parseScopedProjectKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useBoardsDispatch } from "../../state/boards";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useWorkspacesDispatch } from "../../state/workspaces";
import { toastManager } from "../ui/toast";
import { useProjects } from "../../state/entities";
import type { TicketView } from "./useBoardsModel";

/** Resolves a stored scoped project key to a project this client still has. */
export function useProjectLookup(): (key: string | null) => EnvironmentProject | null {
  const projects = useProjects();
  return useCallback(
    (key) => {
      const ref = key === null ? null : parseScopedProjectKey(key);
      if (!ref) return null;
      return (
        projects.find(
          (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
        ) ?? null
      );
    },
    [projects],
  );
}

/**
 * Boards live on the primary environment's server, and a ticket's chats read
 * the ticket through that server's tools, so its projects must be there too.
 */
function onBoardsEnvironment(
  projectRef: ScopedProjectRef,
  primaryEnvironmentId: EnvironmentId | null,
): boolean {
  if (projectRef.environmentId === primaryEnvironmentId) return true;
  toastManager.add({
    type: "error",
    title: "Pick a project on this server",
    description:
      "Tickets live on the server that holds the boards, so their chats need one of its projects.",
  });
  return false;
}

/** Opens the command palette's project picker and hands back the scoped key. */
export function usePickProjectKey(): (onPick: (projectKey: string) => void) => void {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useCallback(
    (onPick) =>
      openCommandPalette({
        open: "new-thread-in",
        onPickProject: (projectRef) => {
          if (onBoardsEnvironment(projectRef, primaryEnvironmentId)) {
            onPick(scopedProjectKey(projectRef));
          }
        },
      }),
    [primaryEnvironmentId],
  );
}

/**
 * Starts a chat for a ticket: in the ticket's project, then the board's
 * default, else (or with `pickProject`) the project picker. The chat is linked
 * to the ticket and its composer is prefilled with a one-line opener.
 */
export function useStartTicketSession(): (
  view: TicketView,
  options: { readonly pickProject: boolean },
) => Promise<void> {
  const handleNewThread = useNewThreadHandler();
  const dispatch = useBoardsDispatch();
  const workspacesDispatch = useWorkspacesDispatch();
  const lookupProject = useProjectLookup();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useCallback(
    async (view, options) => {
      const start = async (projectRef: ScopedProjectRef, inTicketProject: boolean) => {
        if (!onBoardsEnvironment(projectRef, primaryEnvironmentId)) return;
        // In the ticket's own project the chat runs in the ticket's workspace,
        // shared with its hook chats; a project picked by hand gets a plain chat.
        const workspace = inTicketProject
          ? await workspacesDispatch(
              { type: "workspace.ensure", ticketId: view.ticket.id },
              { quiet: true },
            )
          : undefined;
        // Only a ticket set to work in the project checkout starts there; any
        // other failure stops, so ticket work never lands in the shared checkout.
        if (workspace && !workspace.ok && workspace.code !== "no-workspace") {
          toastManager.add({
            type: "error",
            title: "Could not prepare the ticket's workspace",
            description: workspace.message,
          });
          return;
        }
        const placed = workspace?.ok ? workspace.result : null;
        const result = await handleNewThread(
          projectRef,
          placed?.path
            ? { worktreePath: placed.path, branch: placed.branch, envMode: "worktree" }
            : undefined,
        );
        if (result === null) return;
        if (placed?.created) {
          void workspacesDispatch({
            type: "workspace.setup",
            ticketId: view.ticket.id,
            threadId: result.threadId,
          });
        }
        await dispatch({
          type: "thread.link",
          threadKey: scopedThreadKey(scopeThreadRef(projectRef.environmentId, result.threadId)),
          ticketId: view.ticket.id,
        });
        const store = useComposerDraftStore.getState();
        const existing = store.getComposerDraft(result.draftId)?.prompt.trim() ?? "";
        // One line: the agent reads the rest (criteria, handoff) with get_ticket, so it
        // stays current. A reused draft may hold text already; keep it above.
        const opener = `Work on ticket ${view.label}: ${view.ticket.title}`;
        store.setPrompt(result.draftId, existing ? `${existing}\n\n${opener}` : opener);
      };
      const project = options.pickProject
        ? null
        : (lookupProject(view.ticket.projectKey) ?? lookupProject(view.board.defaultProjectKey));
      if (project) {
        await start(scopeProjectRef(project.environmentId, project.id), true);
        return;
      }
      openCommandPalette({
        open: "new-thread-in",
        onPickProject: (picked) => void start(picked, false),
      });
    },
    [dispatch, handleNewThread, lookupProject, primaryEnvironmentId, workspacesDispatch],
  );
}
