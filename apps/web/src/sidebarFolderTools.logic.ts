import {
  SidebarFoldersError,
  type SidebarFolderAction,
  type SidebarFolderReply,
  type SidebarFolderSummary,
} from "@t3tools/contracts";

import {
  flattenSidebarFolders,
  folderSubtreeIds,
  folderSubtreeThreadKeys,
  type SidebarFolderLayout,
} from "./components/SidebarFolders.logic";
import {
  folderRouteSourcesIn,
  sidebarFolderPath,
  type TicketFolderRoutingState,
} from "./components/boards/ticketFolders.logic";

type FolderStore = SidebarFolderLayout &
  TicketFolderRoutingState & {
    readonly deleteFolder: (folderId: string) => void;
  };

export function listSidebarFolderSummaries(
  layout: SidebarFolderLayout & TicketFolderRoutingState,
): SidebarFolderSummary[] {
  return flattenSidebarFolders(layout).map(({ folder }) => {
    const routed = folderRouteSourcesIn(layout, folderSubtreeIds(layout, folder.id));
    return {
      id: folder.id,
      name: folder.name,
      path: sidebarFolderPath(layout, folder.id) ?? folder.name,
      parentId: folder.parentId,
      threadCount: new Set(layout.threadKeysByFolderId[folder.id] ?? []).size,
      subtreeThreadCount: folderSubtreeThreadKeys(layout, folder.id).length,
      settled: layout.settledFolderIds?.includes(folder.id) ?? false,
      routedTickets: routed.tickets,
      routedTasks: routed.tasks,
    };
  });
}

/** Uses the same deletion action as the folder menu, including routed folder paths. */
export function executeSidebarFolderAction(
  store: FolderStore,
  action: SidebarFolderAction,
): Pick<SidebarFolderReply, "result" | "error"> {
  if (action.type === "list")
    return { result: { type: "listed", folders: listSidebarFolderSummaries(store) } };
  if (!store.folders.some((folder) => folder.id === action.folderId))
    return { error: new SidebarFoldersError({ code: "not-found" }) };
  const deletedFolderIds = [...folderSubtreeIds(store, action.folderId)];
  const releasedThreadCount = folderSubtreeThreadKeys(store, action.folderId).length;
  const routed = folderRouteSourcesIn(store, new Set(deletedFolderIds));
  store.deleteFolder(action.folderId);
  return {
    result: {
      type: "deleted",
      deletedFolderIds,
      releasedThreadCount,
      queuedTicketFolderClears: routed.tickets,
      queuedTaskFolderClears: routed.tasks,
    },
  };
}
