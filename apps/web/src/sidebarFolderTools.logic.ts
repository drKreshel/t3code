import {
  SidebarFoldersError,
  type SidebarFolderAction,
  type SidebarFolderReply,
  type SidebarFolderSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

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
  isExistingThread: (threadKey: string) => boolean,
): SidebarFolderSummary[] {
  return flattenSidebarFolders(layout).map(({ folder }) => {
    const routed = folderRouteSourcesIn(layout, folderSubtreeIds(layout, folder.id));
    return {
      id: folder.id,
      name: folder.name,
      path: sidebarFolderPath(layout, folder.id) ?? folder.name,
      parentId: folder.parentId,
      threadCount: new Set((layout.threadKeysByFolderId[folder.id] ?? []).filter(isExistingThread))
        .size,
      subtreeThreadCount: folderSubtreeThreadKeys(layout, folder.id).filter(isExistingThread)
        .length,
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
  isExistingThread: (threadKey: string) => boolean,
): Pick<SidebarFolderReply, "result" | "error"> {
  if (action.type === "list")
    return {
      result: { type: "listed", folders: listSidebarFolderSummaries(store, isExistingThread) },
    };
  if (!store.folders.some((folder) => folder.id === action.folderId))
    return { error: SidebarFoldersError.fromCode("not-found") };
  const deletedFolderIds = [...folderSubtreeIds(store, action.folderId)];
  const releasedThreadCount = folderSubtreeThreadKeys(store, action.folderId).filter(
    isExistingThread,
  ).length;
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

/** Claims before reading or changing the layout, so expired queued calls cannot mutate it. */
export function executeClaimedSidebarFolderAction<E, R>(
  claim: Effect.Effect<boolean, E, R>,
  readStore: () => FolderStore,
  action: SidebarFolderAction,
  isExistingThread: (threadKey: string) => boolean,
) {
  return claim.pipe(
    Effect.map((active) =>
      active ? executeSidebarFolderAction(readStore(), action, isExistingThread) : null,
    ),
  );
}
