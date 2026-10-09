import { ScheduledTaskId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useSidebarFolderStore } from "../../sidebarFolderStore";
import { useBoards, useBoardsDispatch } from "../../state/boards";
import { useSetTaskFolder, useTaskFolders } from "../../state/taskFolders";
import {
  type FolderRouteSource,
  type PendingFolderPath,
  TASK_FOLDER_SOURCE_PREFIX,
} from "./ticketFolders.logic";

/**
 * Files manual sessions, drafts, and automation sessions through their ticket
 * links, and scheduled task runs into their task's folder. Waits for both, since
 * a source left out of a sync loses its route. Sends the folder paths that
 * sidebar moves, renames, and deletes changed back to their ticket or task.
 */
export function TicketFolderCoordinator() {
  const boards = useBoards();
  const taskFolders = useTaskFolders();
  const dispatch = useBoardsDispatch();
  const setTaskFolder = useSetTaskFolder();
  const sent = useRef(new Map<string, string | null>());
  const ready = boards.status === "ready" && taskFolders.status !== "loading";

  useEffect(() => {
    if (boards.status !== "ready" || taskFolders.status === "loading") return;
    const taskSources: FolderRouteSource[] =
      taskFolders.status === "ready"
        ? taskFolders.routes.map((route) => ({
            id: `${TASK_FOLDER_SOURCE_PREFIX}${route.taskId}`,
            folder: route.folder,
            archivedAt: null,
            threadKeys: route.threadKeys,
          }))
        : [];
    useSidebarFolderStore
      .getState()
      .syncTicketFolders([...boards.snapshot.tickets, ...taskSources]);
  }, [boards, taskFolders]);

  useEffect(() => {
    if (!ready) return;
    const send = (pending: Readonly<Record<string, PendingFolderPath>>) => {
      for (const sourceId of sent.current.keys()) {
        if (!(sourceId in pending)) sent.current.delete(sourceId);
      }
      for (const [sourceId, { path }] of Object.entries(pending)) {
        if (sent.current.has(sourceId) && sent.current.get(sourceId) === path) continue;
        sent.current.set(sourceId, path);
        const write = sourceId.startsWith(TASK_FOLDER_SOURCE_PREFIX)
          ? setTaskFolder({
              taskId: ScheduledTaskId.make(sourceId.slice(TASK_FOLDER_SOURCE_PREFIX.length)),
              folder: path,
            })
          : dispatch({ type: "ticket.update", ticketId: sourceId, folder: path }).then(
              (result) => result !== undefined,
            );
        void write.then((ok) => {
          if (!ok) useSidebarFolderStore.getState().dropPendingFolderPath(sourceId, path);
        });
      }
    };
    send(useSidebarFolderStore.getState().pendingFolderPaths ?? {});
    return useSidebarFolderStore.subscribe((state, previous) => {
      if (state.pendingFolderPaths !== previous.pendingFolderPaths) {
        send(state.pendingFolderPaths ?? {});
      }
    });
  }, [ready, dispatch, setTaskFolder]);
  return null;
}
