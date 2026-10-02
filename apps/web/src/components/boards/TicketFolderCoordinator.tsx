import { useEffect } from "react";

import { useSidebarFolderStore } from "../../sidebarFolderStore";
import { useBoards } from "../../state/boards";

/** Files manual sessions, drafts, and automation sessions through their ticket links. */
export function TicketFolderCoordinator() {
  const boards = useBoards();
  useEffect(() => {
    if (boards.status === "ready") {
      useSidebarFolderStore.getState().syncTicketFolders(boards.snapshot.tickets);
    }
  }, [boards]);
  return null;
}
