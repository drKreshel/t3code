import type { Ticket } from "@t3tools/contracts";

import {
  createSidebarFolder,
  moveThreadToSidebarFolder,
  type SidebarFolderLayout,
} from "../SidebarFolders.logic";

/** The local folder that currently stands for a source's folder path. */
interface TicketFolderRoute {
  readonly path: string;
  readonly folderId: string;
  readonly threadKeys: readonly string[];
}

/** A folder path this client sent for a source, until the server echoes it. */
export interface PendingFolderPath {
  /** Null clears the source's folder. */
  readonly path: string | null;
  /** Server values that mean the write has not landed yet. */
  readonly from: readonly (string | null)[];
}

/** Anything that files chats into a folder: a ticket, or a scheduled task (`task:<id>`). */
export type FolderRouteSource = Pick<Ticket, "id" | "folder" | "archivedAt" | "threadKeys">;

export interface TicketFolderRoutingState {
  readonly ticketFolderRoutes?: Readonly<Record<string, TicketFolderRoute>>;
  readonly pendingFolderPaths?: Readonly<Record<string, PendingFolderPath>>;
}

export const TASK_FOLDER_SOURCE_PREFIX = "task:";

function normalizeFolderPath(folder: string | null | undefined): string | null {
  if (!folder) return null;
  const names = folder.split("/").map((name) => name.trim());
  return names.some((name) => name.length === 0) ? null : names.join("/");
}

/** A folder's path as `/`-joined names, or null when it no longer exists. */
export function sidebarFolderPath(layout: SidebarFolderLayout, folderId: string): string | null {
  const byId = new Map(layout.folders.map((folder) => [folder.id, folder]));
  const names: string[] = [];
  let folder = byId.get(folderId);
  while (folder !== undefined && names.length <= byId.size) {
    names.unshift(folder.name);
    if (folder.parentId === null) return names.join("/");
    folder = byId.get(folder.parentId);
  }
  return null;
}

/**
 * Keeps the sidebar and each ticket's or task's folder path in step. The path
 * on the server is the source of truth: a changed path refiles the source's
 * chats, and moving, renaming, or deleting its folder here becomes a pending
 * path change for the coordinator to send. Pass every source at once: a source
 * left out loses its route.
 */
export function syncTicketFolders(
  state: SidebarFolderLayout & TicketFolderRoutingState,
  sources: readonly FolderRouteSource[],
  newId: () => string,
): SidebarFolderLayout & TicketFolderRoutingState {
  let layout: SidebarFolderLayout = state;
  const previousRoutes = state.ticketFolderRoutes ?? {};
  const previousPending = state.pendingFolderPaths ?? {};
  const routes: Record<string, TicketFolderRoute> = {};
  const pending: Record<string, PendingFolderPath> = {};
  let changed = false;

  for (const source of sources) {
    const server = normalizeFolderPath(source.folder);
    let waiting: PendingFolderPath | undefined = previousPending[source.id];
    // Landed, or overtaken by someone else's change: the server wins again.
    if (waiting && (server === waiting.path || !waiting.from.includes(server))) {
      waiting = undefined;
    }
    let wanted = waiting ? waiting.path : server;
    const prior = previousRoutes[source.id];
    const live = prior ? sidebarFolderPath(layout, prior.folderId) : null;
    if (prior && prior.path === wanted && live !== wanted) {
      // Moved, renamed, or deleted in this sidebar: the source follows.
      waiting = { path: live, from: [...new Set([...(waiting?.from ?? []), wanted])] };
      wanted = live;
    }
    if (waiting) {
      pending[source.id] = waiting;
      if (waiting !== previousPending[source.id]) changed = true;
    }
    if (wanted === null) continue;

    const reuse = prior !== undefined && live === wanted;
    const archived = source.archivedAt !== null;
    // Archived sources keep their route so folder moves still update them.
    if (archived) {
      if (!reuse) continue;
      routes[source.id] = prior.path === wanted ? prior : { ...prior, path: wanted };
      if (routes[source.id] !== prior) changed = true;
      continue;
    }

    let folderId: string;
    if (reuse) {
      folderId = prior.folderId;
    } else {
      let parentId: string | null = null;
      for (const name of wanted.split("/")) {
        const existing = layout.folders.find(
          (folder) => folder.parentId === parentId && folder.name === name,
        );
        const id = existing?.id ?? newId();
        if (!existing) {
          layout = createSidebarFolder(layout, { id, name, parentId });
        }
        parentId = id;
      }
      folderId = parentId!;
    }
    const alreadyFiled = new Set(reuse ? prior.threadKeys : []);
    for (const threadKey of source.threadKeys) {
      if (alreadyFiled.has(threadKey)) continue;
      layout = moveThreadToSidebarFolder(layout, threadKey, { folderId, position: "end" });
    }
    if (
      reuse &&
      prior.path === wanted &&
      prior.threadKeys.length === source.threadKeys.length &&
      prior.threadKeys.every((key, index) => key === source.threadKeys[index])
    ) {
      routes[source.id] = prior;
    } else {
      routes[source.id] = { path: wanted, folderId, threadKeys: source.threadKeys };
      changed = true;
    }
  }

  if (Object.keys(previousRoutes).length !== Object.keys(routes).length) changed = true;
  if (Object.keys(previousPending).length !== Object.keys(pending).length) changed = true;
  return !changed && layout === state
    ? state
    : { ...layout, ticketFolderRoutes: routes, pendingFolderPaths: pending };
}

/** Tickets and scheduled tasks whose folder is this folder or one inside it. */
export function folderRouteSourcesIn(
  state: TicketFolderRoutingState,
  folderIds: ReadonlySet<string>,
): { readonly tickets: number; readonly tasks: number } {
  let tickets = 0;
  let tasks = 0;
  for (const [sourceId, route] of Object.entries(state.ticketFolderRoutes ?? {})) {
    if (!folderIds.has(route.folderId)) continue;
    if (sourceId.startsWith(TASK_FOLDER_SOURCE_PREFIX)) tasks += 1;
    else tickets += 1;
  }
  return { tickets, tasks };
}
