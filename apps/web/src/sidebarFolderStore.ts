import type { ProjectIconOverride } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  type FolderRouteSource,
  syncTicketFolders,
  type TicketFolderRoutingState,
} from "./components/boards/ticketFolders.logic";
import {
  createSidebarFolder,
  deleteSidebarFolder,
  EMPTY_SIDEBAR_FOLDER_LAYOUT,
  fileForksWithSources,
  moveSidebarFolder,
  moveThreadToSidebarFolder,
  renameSidebarFolder,
  setSidebarFolderDefaultProject,
  setSidebarFolderIcon,
  setSidebarFolderSettled,
  toggleSidebarFolderCollapsed,
  toggleSidebarFolderSettledExpanded,
  type SidebarFolder,
  type SidebarFolderDropSlot,
  type SidebarFolderLayout,
  type SidebarFolderMoveTarget,
  type SidebarThreadFolderTarget,
} from "./components/SidebarFolders.logic";
import type { SidebarDropVerb } from "./components/Sidebar.logic";
import { resolveStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";

const SIDEBAR_FOLDER_STORAGE_KEY = "t3code:sidebar-folders:v1";

/**
 * Sidebar folders are a client-local layout, like the project scope: they
 * live in this browser or desktop app and never reach a server. The one
 * exception is a ticket's or scheduled task's folder path, which lives on the
 * server and follows moves, renames, and deletes here (`ticketFolders.logic`).
 */
interface SidebarFolderStoreState extends SidebarFolderLayout, TicketFolderRoutingState {
  syncTicketFolders: (sources: readonly FolderRouteSource[]) => void;
  /** Forgets a path change the server refused, so the sidebar follows the server again. */
  dropPendingFolderPath: (sourceId: string, path: string | null) => void;
  createFolder: (input: { name: string; parentId: string | null }) => string;
  setFolderIcon: (folderId: string, icon: ProjectIconOverride | null) => void;
  renameFolder: (folderId: string, name: string) => void;
  deleteFolder: (folderId: string) => void;
  setFolderDefaultProject: (folderId: string, projectKey: string | null) => void;
  moveFolder: (folderId: string, target: SidebarFolderMoveTarget) => void;
  toggleFolderCollapsed: (folderId: string) => void;
  toggleFolderSettledExpanded: (folderId: string) => void;
  setFolderSettled: (folderId: string, settled: boolean) => void;
  moveThread: (threadKey: string, target: SidebarThreadFolderTarget | null) => void;
  fileForks: (forks: readonly { threadKey: string; sourceThreadKey: string }[]) => void;
}

function layoutOf(
  state: SidebarFolderLayout & TicketFolderRoutingState,
): SidebarFolderLayout & TicketFolderRoutingState {
  return {
    folders: state.folders,
    threadKeysByFolderId: state.threadKeysByFolderId,
    collapsedFolderIds: state.collapsedFolderIds,
    expandedSettledFolderIds: state.expandedSettledFolderIds ?? [],
    settledFolderIds: state.settledFolderIds ?? [],
    ticketFolderRoutes: state.ticketFolderRoutes ?? {},
    pendingFolderPaths: state.pendingFolderPaths ?? {},
  };
}

// The last synced tickets and tasks, so a folder edit updates their paths at once.
let folderRouteSources: readonly FolderRouteSource[] | null = null;

function resyncFolderRoutes(
  layout: SidebarFolderLayout & TicketFolderRoutingState,
): SidebarFolderLayout & TicketFolderRoutingState {
  return folderRouteSources === null
    ? layout
    : syncTicketFolders(layout, folderRouteSources, randomUUID);
}

export const useSidebarFolderStore = create<SidebarFolderStoreState>()(
  persist(
    (set) => ({
      ...EMPTY_SIDEBAR_FOLDER_LAYOUT,
      ticketFolderRoutes: {},
      pendingFolderPaths: {},
      syncTicketFolders: (sources) => {
        folderRouteSources = sources;
        set((state) => syncTicketFolders(state, sources, randomUUID));
      },
      dropPendingFolderPath: (sourceId, path) =>
        set((state) => {
          const pending = state.pendingFolderPaths ?? {};
          if (pending[sourceId]?.path !== path) return state;
          const { [sourceId]: _dropped, ...rest } = pending;
          return resyncFolderRoutes({ ...layoutOf(state), pendingFolderPaths: rest });
        }),
      createFolder: ({ name, parentId }) => {
        const folder: SidebarFolder = { id: randomUUID(), name, parentId };
        set((state) => createSidebarFolder(layoutOf(state), folder));
        return folder.id;
      },
      setFolderIcon: (folderId, icon) =>
        set((state) => setSidebarFolderIcon(layoutOf(state), folderId, icon)),
      renameFolder: (folderId, name) =>
        set((state) => resyncFolderRoutes(renameSidebarFolder(layoutOf(state), folderId, name))),
      deleteFolder: (folderId) =>
        set((state) => resyncFolderRoutes(deleteSidebarFolder(layoutOf(state), folderId))),
      setFolderDefaultProject: (folderId, projectKey) =>
        set((state) => setSidebarFolderDefaultProject(layoutOf(state), folderId, projectKey)),
      moveFolder: (folderId, target) =>
        set((state) => resyncFolderRoutes(moveSidebarFolder(layoutOf(state), folderId, target))),
      toggleFolderCollapsed: (folderId) =>
        set((state) => toggleSidebarFolderCollapsed(layoutOf(state), folderId)),
      toggleFolderSettledExpanded: (folderId) =>
        set((state) => toggleSidebarFolderSettledExpanded(layoutOf(state), folderId)),
      setFolderSettled: (folderId, settled) =>
        set((state) => setSidebarFolderSettled(layoutOf(state), folderId, settled)),
      moveThread: (threadKey, target) =>
        set((state) => moveThreadToSidebarFolder(layoutOf(state), threadKey, target)),
      fileForks: (forks) => set((state) => fileForksWithSources(layoutOf(state), forks)),
    }),
    {
      name: SIDEBAR_FOLDER_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state: SidebarFolderStoreState) => layoutOf(state),
    },
  ),
);

/**
 * Transient folder UI: the folder being renamed and the live drop slot while
 * dragging. Kept out of the Sidebar component so pointer moves only re-render
 * the folder rows that draw the indicator.
 */
interface SidebarFolderUiState {
  renamingFolderId: string | null;
  choosingIconFolderId: string | null;
  setChoosingIconFolderId: (folderId: string | null) => void;
  dropSlot: SidebarFolderDropSlot | null;
  /** Something is being dragged that folders can accept. */
  dragKind: "folder" | "thread" | null;
  /** Badge for a filed thread lifted over the main list. */
  leaveDropVerb: SidebarDropVerb | null;
  setRenamingFolderId: (folderId: string | null) => void;
  setDropSlot: (slot: SidebarFolderDropSlot | null) => void;
  setDragKind: (kind: "folder" | "thread" | null) => void;
  setLeaveDropVerb: (verb: SidebarDropVerb | null) => void;
}

export const useSidebarFolderUiStore = create<SidebarFolderUiState>((set) => ({
  renamingFolderId: null,
  choosingIconFolderId: null,
  setChoosingIconFolderId: (choosingIconFolderId) => set({ choosingIconFolderId }),
  dropSlot: null,
  dragKind: null,
  leaveDropVerb: null,
  setRenamingFolderId: (renamingFolderId) => set({ renamingFolderId }),
  setDropSlot: (dropSlot) =>
    set((state) => (sameDropSlot(state.dropSlot, dropSlot) ? state : { dropSlot })),
  setDragKind: (dragKind) => set({ dragKind }),
  setLeaveDropVerb: (leaveDropVerb) => set({ leaveDropVerb }),
}));

function sameDropSlot(a: SidebarFolderDropSlot | null, b: SidebarFolderDropSlot | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "root" || b.kind === "root") return a.kind === b.kind;
  if (a.kind === "folder" && b.kind === "folder") {
    return a.folderId === b.folderId && a.zone === b.zone;
  }
  if (a.kind === "thread" && b.kind === "thread") {
    return a.threadKey === b.threadKey && a.zone === b.zone;
  }
  return false;
}
