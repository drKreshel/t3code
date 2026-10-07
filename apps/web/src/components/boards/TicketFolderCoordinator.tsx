import { useEffect } from "react";

import { useSidebarFolderStore } from "../../sidebarFolderStore";
import { useBoards } from "../../state/boards";
import { useTaskFolders } from "../../state/taskFolders";
import type { FolderRouteSource } from "./ticketFolders.logic";

/**
 * Files manual sessions, drafts, and automation sessions through their ticket
 * links, and scheduled task runs into their task's folder. Waits for both, since
 * a source left out of a sync loses its route.
 */
export function TicketFolderCoordinator() {
  const boards = useBoards();
  const taskFolders = useTaskFolders();
  useEffect(() => {
    if (boards.status !== "ready" || taskFolders.status === "loading") return;
    const taskSources: FolderRouteSource[] =
      taskFolders.status === "ready"
        ? taskFolders.routes.map((route) => ({
            id: `task:${route.taskId}`,
            folder: route.folder,
            archivedAt: null,
            threadKeys: route.threadKeys,
          }))
        : [];
    useSidebarFolderStore
      .getState()
      .syncTicketFolders([...boards.snapshot.tickets, ...taskSources]);
  }, [boards, taskFolders]);
  return null;
}
