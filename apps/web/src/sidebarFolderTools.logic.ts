import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  SidebarFoldersError,
  type OrganizingIconOverride,
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
    readonly createFolder: (input: {
      readonly name: string;
      readonly parentId: string | null;
    }) => string;
    readonly deleteFolder: (folderId: string) => void;
    readonly setFolderIcon: (folderId: string, icon: OrganizingIconOverride | null) => void;
    readonly setFolderSettled: (folderId: string, settled: boolean) => void;
    readonly moveThread: (
      threadKey: string,
      target: { readonly folderId: string; readonly position: "end" } | null,
    ) => void;
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
      icon: folder.icon ?? null,
      threadCount: new Set((layout.threadKeysByFolderId[folder.id] ?? []).filter(isExistingThread))
        .size,
      subtreeThreadCount: folderSubtreeThreadKeys(layout, folder.id).filter(isExistingThread)
        .length,
      settled: layout.settledFolderIds?.includes(folder.id) ?? false,
      routedTickets: routed.tickets,
      routedTasks: routed.tasks,
      routedChats: routed.chats,
    };
  });
}

/** Uses the same folder-store mutations as the sidebar UI. */
export function executeSidebarFolderAction(
  store: FolderStore,
  action: SidebarFolderAction,
  isExistingThread: (threadKey: string) => boolean,
): Pick<SidebarFolderReply, "result" | "error"> {
  if (action.type === "list")
    return {
      result: { type: "listed", folders: listSidebarFolderSummaries(store, isExistingThread) },
    };
  if (action.type === "create") {
    const names = action.path.split("/").map((name) => name.trim());
    if (names.some((name) => name.length === 0))
      return { error: SidebarFoldersError.fromCode("invalid-path") };
    const folders = [...store.folders];
    const createdFolderIds: string[] = [];
    let parentId: string | null = null;
    for (const name of names) {
      const existing = folders.find(
        (folder) => folder.parentId === parentId && folder.name === name,
      );
      if (existing !== undefined) {
        parentId = existing.id;
        continue;
      }
      const id = store.createFolder({ name, parentId });
      folders.push({ id, name, parentId });
      createdFolderIds.push(id);
      parentId = id;
    }
    return {
      result: {
        type: "folder-created",
        folderId: parentId!,
        path: names.join("/"),
        createdFolderIds,
      },
    };
  }
  if (action.type === "move-thread") {
    const threadKey = scopedThreadKey(action.thread);
    if (!isExistingThread(threadKey))
      return { error: SidebarFoldersError.fromCode("thread-not-found") };
    if (action.folderId !== null && !store.folders.some((folder) => folder.id === action.folderId))
      return { error: SidebarFoldersError.fromCode("not-found") };
    store.moveThread(
      threadKey,
      action.folderId === null ? null : { folderId: action.folderId, position: "end" },
    );
    return {
      result: {
        type: "thread-moved",
        thread: action.thread,
        folderId: action.folderId,
      },
    };
  }
  const folder = store.folders.find((candidate) => candidate.id === action.folderId);
  if (folder === undefined) return { error: SidebarFoldersError.fromCode("not-found") };
  if (action.type === "set-icon") {
    store.setFolderIcon(action.folderId, action.icon);
    return {
      result: {
        type: "folder-icon-updated",
        folderId: action.folderId,
        icon: action.icon,
      },
    };
  }
  if (action.type === "set-settled") {
    store.setFolderSettled(action.folderId, action.settled);
    return {
      result: {
        type: "folder-settled",
        folderId: action.folderId,
        settled: action.settled,
      },
    };
  }
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
      queuedChatFolderClears: routed.chats,
    },
  };
}

/** Claims before reading or changing the layout, so expired queued calls cannot mutate it. */
export const executeClaimedSidebarFolderAction = Effect.fn(
  "sidebarFolderTools.executeClaimedSidebarFolderAction",
)(function* <E, R, R2 = never>(
  claim: Effect.Effect<boolean, E, R>,
  readStore: () => FolderStore,
  action: SidebarFolderAction,
  isExistingThread: (threadKey: string) => boolean,
  settleThreads?: (threadKeys: readonly string[]) => Effect.Effect<boolean, never, R2>,
) {
  if (!(yield* claim)) return null;
  const store = readStore();
  if (
    action.type === "set-settled" &&
    action.settled &&
    settleThreads !== undefined &&
    store.folders.some((folder) => folder.id === action.folderId)
  ) {
    const threadKeys = folderSubtreeThreadKeys(store, action.folderId);
    if (threadKeys.length > 0 && !(yield* settleThreads(threadKeys))) {
      return { error: SidebarFoldersError.fromCode("thread-settlement-failed") };
    }
  }
  return executeSidebarFolderAction(store, action, isExistingThread);
});
