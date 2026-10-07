import type { Ticket } from "@t3tools/contracts";

import {
  createSidebarFolder,
  moveThreadToSidebarFolder,
  type SidebarFolderLayout,
} from "../SidebarFolders.logic";

interface TicketFolderRoute {
  readonly path: string;
  readonly folderId: string;
  readonly threadKeys: readonly string[];
}

/** Anything that files chats into a folder: a ticket, or a scheduled task (`task:<id>`). */
export type FolderRouteSource = Pick<Ticket, "id" | "folder" | "archivedAt" | "threadKeys">;

export interface TicketFolderRoutingState {
  readonly ticketFolderRoutes?: Readonly<Record<string, TicketFolderRoute>>;
}

/**
 * Applies a ticket's or task's folder when it is assigned or a chat is linked.
 * Remembering the applied route preserves later manual filing and local folder
 * renames. Pass every source at once: a source left out loses its route.
 */
export function syncTicketFolders(
  state: SidebarFolderLayout & TicketFolderRoutingState,
  tickets: readonly FolderRouteSource[],
  newId: () => string,
): SidebarFolderLayout & TicketFolderRoutingState {
  let layout: SidebarFolderLayout = state;
  const previous = state.ticketFolderRoutes ?? {};
  const routes: Record<string, TicketFolderRoute> = {};
  let changed = false;

  for (const ticket of tickets) {
    if (!ticket.folder || ticket.archivedAt !== null) continue;
    const names = ticket.folder.split("/").map((name) => name.trim());
    if (names.some((name) => name.length === 0)) continue;
    const path = names.join("/");
    const prior = previous[ticket.id];
    const reuse =
      prior?.path === path && layout.folders.some((folder) => folder.id === prior.folderId);
    let folderId: string;
    if (reuse) {
      folderId = prior.folderId;
    } else {
      let parentId: string | null = null;
      for (const name of names) {
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
    for (const threadKey of ticket.threadKeys) {
      if (alreadyFiled.has(threadKey)) continue;
      layout = moveThreadToSidebarFolder(layout, threadKey, { folderId, position: "end" });
    }
    if (
      reuse &&
      prior.threadKeys.length === ticket.threadKeys.length &&
      prior.threadKeys.every((key, index) => key === ticket.threadKeys[index])
    ) {
      routes[ticket.id] = prior;
    } else {
      routes[ticket.id] = { path, folderId, threadKeys: ticket.threadKeys };
      changed = true;
    }
  }

  if (Object.keys(previous).length !== Object.keys(routes).length) changed = true;
  return !changed && layout === state ? state : { ...layout, ticketFolderRoutes: routes };
}
