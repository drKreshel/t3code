import {
  parseScopedProjectKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { readLocalApi } from "../../localApi";
import { useBoardsDispatch } from "../../state/boards";
import { useProjects } from "../../state/entities";
import { ticketBriefing } from "./boards.logic";
import type { TicketView } from "./useBoardsModel";

/** Asks before starting a blocked ticket; resolves true when it may go ahead. */
export async function confirmStartBlocked(view: TicketView): Promise<boolean> {
  if (view.blockers.length === 0) return true;
  const api = readLocalApi();
  if (!api) return false;
  const waitingOn = view.blockerLabels.join(", ");
  const confirmed = await settlePromise(() =>
    api.dialogs.confirm(
      `Start ${view.label} anyway?\nIt requires ${waitingOn}, which ${view.blockers.length === 1 ? "is" : "are"} not done yet.`,
    ),
  );
  return confirmed._tag === "Success" && confirmed.value;
}

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

/** Opens the command palette's project picker and hands back the scoped key. */
export function pickProjectKey(onPick: (projectKey: string) => void): void {
  openCommandPalette({
    open: "new-thread-in",
    onPickProject: (projectRef) => onPick(scopedProjectKey(projectRef)),
  });
}

/**
 * Starts a chat for a ticket: in the ticket's project, then the board's
 * default, else (or with `pickProject`) the project picker. The chat is linked
 * to the ticket and its composer is prefilled with a briefing.
 */
export function useStartTicketSession(): (
  view: TicketView,
  options: { readonly pickProject: boolean; readonly handoff: string | null },
) => Promise<void> {
  const handleNewThread = useNewThreadHandler();
  const dispatch = useBoardsDispatch();
  const lookupProject = useProjectLookup();
  return useCallback(
    async (view, options) => {
      if (!(await confirmStartBlocked(view))) return;
      const start = async (projectRef: ScopedProjectRef) => {
        const result = await handleNewThread(projectRef);
        if (result === null) return;
        await dispatch({
          type: "thread.link",
          threadKey: scopedThreadKey(scopeThreadRef(projectRef.environmentId, result.threadId)),
          ticketId: view.ticket.id,
        });
        const store = useComposerDraftStore.getState();
        const existing = store.getComposerDraft(result.draftId)?.prompt.trim() ?? "";
        const briefing = ticketBriefing({
          label: view.label,
          ticket: view.ticket,
          handoff: options.handoff,
        });
        // A reused draft may hold text already; keep it above the briefing.
        store.setPrompt(result.draftId, existing ? `${existing}\n\n${briefing}` : briefing);
      };
      const project = options.pickProject
        ? null
        : (lookupProject(view.ticket.projectKey) ?? lookupProject(view.board.defaultProjectKey));
      if (project) {
        await start(scopeProjectRef(project.environmentId, project.id));
        return;
      }
      openCommandPalette({
        open: "new-thread-in",
        onPickProject: (picked) => void start(picked),
      });
    },
    [dispatch, handleNewThread, lookupProject],
  );
}
