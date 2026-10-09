import type { Ticket } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createSidebarFolder,
  deleteSidebarFolder,
  EMPTY_SIDEBAR_FOLDER_LAYOUT,
  flattenSidebarFolders,
  moveSidebarFolder,
  moveThreadToSidebarFolder,
  renameSidebarFolder,
} from "../SidebarFolders.logic";
import { folderRouteSourcesIn, syncTicketFolders } from "./ticketFolders.logic";

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: "ticket-1",
  boardId: "salon",
  number: 2,
  title: "Finish salones infantiles",
  description: "",
  columnId: "todo",
  priority: "none",
  projectKey: null,
  folder: "SalonesDeFiestas/salones-infantiles",
  position: 1,
  flag: null,
  requires: [],
  criteria: [],
  threadKeys: ["env:manual"],
  createdAt: "",
  updatedAt: "",
  archivedAt: null,
  ...overrides,
});

function ids() {
  let next = 0;
  return () => `folder-${++next}`;
}

describe("ticket folder routing", () => {
  it("creates nested folders and files later automation sessions beside the manual session", () => {
    const newId = ids();
    const initial = syncTicketFolders(EMPTY_SIDEBAR_FOLDER_LAYOUT, [ticket()], newId);
    expect(flattenSidebarFolders(initial).map(({ path }) => path)).toEqual([
      "SalonesDeFiestas",
      "SalonesDeFiestas / salones-infantiles",
    ]);
    const updatedTicket = ticket({ threadKeys: ["env:manual", "env:implement", "env:review"] });
    const updated = syncTicketFolders(initial, [updatedTicket], newId);
    expect(updated.folders).toHaveLength(2);
    expect(updated.threadKeysByFolderId["folder-2"]).toEqual(updatedTicket.threadKeys);
    expect(syncTicketFolders(updated, [updatedTicket], newId)).toBe(updated);
  });

  it("creates the folder for a ticket before its first chat and reuses existing parents", () => {
    const newId = ids();
    const initial = syncTicketFolders(
      EMPTY_SIDEBAR_FOLDER_LAYOUT,
      [ticket({ threadKeys: [] })],
      newId,
    );
    const updated = syncTicketFolders(
      initial,
      [
        ticket({ threadKeys: [] }),
        ticket({
          id: "ticket-2",
          folder: "SalonesDeFiestas/ui-polish",
          threadKeys: ["env:polish"],
        }),
      ],
      newId,
    );
    expect(updated.folders).toHaveLength(3);
    expect(updated.threadKeysByFolderId["folder-3"]).toEqual(["env:polish"]);
  });

  it("keeps manual filing and sends a renamed folder's path to its ticket", () => {
    const newId = ids();
    const initial = syncTicketFolders(EMPTY_SIDEBAR_FOLDER_LAYOUT, [ticket()], newId);
    const renamed = renameSidebarFolder(initial, "folder-2", "Kids venues");
    const manuallyMoved = moveThreadToSidebarFolder(renamed, "env:manual", {
      folderId: "folder-1",
      position: "end",
    });
    const saved = JSON.parse(JSON.stringify(manuallyMoved)) as typeof initial;
    const updated = syncTicketFolders(
      saved,
      [ticket({ threadKeys: ["env:manual", "env:review"] })],
      newId,
    );
    expect(updated.folders).toHaveLength(2);
    expect(updated.threadKeysByFolderId["folder-1"]).toEqual(["env:manual"]);
    expect(updated.threadKeysByFolderId["folder-2"]).toEqual(["env:review"]);
    expect(updated.pendingFolderPaths).toEqual({
      "ticket-1": {
        path: "SalonesDeFiestas/Kids venues",
        from: ["SalonesDeFiestas/salones-infantiles"],
      },
    });
  });

  it("keeps a moved folder while its path is in flight and settles on the echo", () => {
    const newId = ids();
    const source = ticket({ folder: "eco/EI-5962" });
    const initial = syncTicketFolders(
      createSidebarFolder(EMPTY_SIDEBAR_FOLDER_LAYOUT, {
        id: "tickets",
        name: "tickets",
        parentId: null,
      }),
      [source],
      newId,
    );
    const moved = syncTicketFolders(
      moveSidebarFolder(initial, "folder-2", { kind: "inside", folderId: "tickets" }),
      [source],
      newId,
    );
    expect(moved.pendingFolderPaths).toEqual({
      "ticket-1": { path: "tickets/EI-5962", from: ["eco/EI-5962"] },
    });
    // A snapshot from before the write lands changes nothing.
    expect(
      syncTicketFolders(moved, [source, ticket({ id: "other", folder: null })], newId).folders,
    ).toBe(moved.folders);
    const manual = moveThreadToSidebarFolder(moved, "env:manual", null);
    const echoed = syncTicketFolders(manual, [ticket({ folder: "tickets/EI-5962" })], newId);
    expect(echoed.pendingFolderPaths).toEqual({});
    expect(echoed.folders).toBe(manual.folders);
    expect(echoed.threadKeysByFolderId).toBe(manual.threadKeysByFolderId);
    expect(echoed.ticketFolderRoutes!["ticket-1"]!.path).toBe("tickets/EI-5962");
  });

  it("sends every path below a moved parent, including shared folders and tasks", () => {
    const newId = ids();
    const sources = [
      ticket({ folder: "eco/EI-5962" }),
      ticket({ id: "ticket-2", folder: "eco/EI-5962", threadKeys: ["env:b"] }),
      ticket({ id: "task:nightly", folder: "eco", threadKeys: ["env:run"] }),
      ticket({ id: "elsewhere", folder: "misc", threadKeys: ["env:misc"] }),
    ];
    const initial = syncTicketFolders(EMPTY_SIDEBAR_FOLDER_LAYOUT, sources, newId);
    const work = createSidebarFolder(initial, { id: "work", name: "work", parentId: null });
    const moved = syncTicketFolders(
      moveSidebarFolder(work, "folder-1", { kind: "inside", folderId: "work" }),
      sources,
      newId,
    );
    expect(
      Object.fromEntries(
        Object.entries(moved.pendingFolderPaths!).map(([id, { path }]) => [id, path]),
      ),
    ).toEqual({
      "ticket-1": "work/eco/EI-5962",
      "ticket-2": "work/eco/EI-5962",
      "task:nightly": "work/eco",
    });
    expect(folderRouteSourcesIn(moved, new Set(["folder-1", "folder-2"]))).toEqual({
      tickets: 2,
      tasks: 1,
    });
  });

  it("clears the folder of tickets whose folder was deleted instead of recreating it", () => {
    const newId = ids();
    const source = ticket({ folder: "eco/EI-5962" });
    const initial = syncTicketFolders(EMPTY_SIDEBAR_FOLDER_LAYOUT, [source], newId);
    const deleted = syncTicketFolders(deleteSidebarFolder(initial, "folder-1"), [source], newId);
    expect(deleted.folders).toEqual([]);
    expect(deleted.pendingFolderPaths).toEqual({
      "ticket-1": { path: null, from: ["eco/EI-5962"] },
    });
    const later = syncTicketFolders(
      deleted,
      [ticket({ folder: "eco/EI-5962", threadKeys: ["env:manual", "env:new"] })],
      newId,
    );
    expect(later.folders).toEqual([]);
    const echoed = syncTicketFolders(later, [ticket({ folder: null })], newId);
    expect(echoed.folders).toEqual([]);
    expect(echoed.pendingFolderPaths).toEqual({});
  });

  it("follows the server again when a write is refused or overtaken", () => {
    const newId = ids();
    const source = ticket({ folder: "eco/EI-5962" });
    const initial = syncTicketFolders(EMPTY_SIDEBAR_FOLDER_LAYOUT, [source], newId);
    const renamed = syncTicketFolders(
      renameSidebarFolder(initial, "folder-2", "Renamed"),
      [source],
      newId,
    );
    const refused = syncTicketFolders({ ...renamed, pendingFolderPaths: {} }, [source], newId);
    expect(flattenSidebarFolders(refused).map(({ path }) => path)).toContain("eco / EI-5962");
    expect(refused.threadKeysByFolderId["folder-3"]).toEqual(["env:manual"]);
    expect(refused.pendingFolderPaths).toEqual({});

    const overtaken = syncTicketFolders(renamed, [ticket({ folder: "agent/pick" })], newId);
    expect(overtaken.pendingFolderPaths).toEqual({});
    expect(overtaken.ticketFolderRoutes!["ticket-1"]!.path).toBe("agent/pick");
  });

  it("keeps archived tickets' routes so folder moves still update them", () => {
    const newId = ids();
    const source = ticket({ folder: "eco/EI-5962" });
    const initial = syncTicketFolders(EMPTY_SIDEBAR_FOLDER_LAYOUT, [source], newId);
    const archived = ticket({
      folder: "eco/EI-5962",
      archivedAt: "2026-10-08",
      threadKeys: ["env:manual", "env:late"],
    });
    const synced = syncTicketFolders(initial, [archived], newId);
    expect(synced).toBe(initial);
    const renamed = syncTicketFolders(
      renameSidebarFolder(synced, "folder-1", "ecoplanet"),
      [archived],
      newId,
    );
    expect(renamed.pendingFolderPaths!["ticket-1"]!.path).toBe("ecoplanet/EI-5962");
    expect(renamed.threadKeysByFolderId["folder-2"]).toEqual(["env:manual"]);
  });

  it("rejects folder names with a slash", () => {
    const initial = syncTicketFolders(EMPTY_SIDEBAR_FOLDER_LAYOUT, [ticket()], ids());
    expect(renameSidebarFolder(initial, "folder-2", "a/b")).toBe(initial);
  });

  it("moves linked sessions when the assigned folder changes and stops filing when cleared", () => {
    const newId = ids();
    const initial = syncTicketFolders(EMPTY_SIDEBAR_FOLDER_LAYOUT, [ticket()], newId);
    const updated = syncTicketFolders(
      initial,
      [ticket({ folder: "SalonesDeFiestas/venues" })],
      newId,
    );
    expect(updated.threadKeysByFolderId["folder-2"]).toEqual([]);
    expect(updated.threadKeysByFolderId["folder-3"]).toEqual(["env:manual"]);
    const cleared = syncTicketFolders(
      updated,
      [ticket({ folder: null, threadKeys: ["env:manual", "env:new"] })],
      newId,
    );
    expect(cleared.threadKeysByFolderId["folder-3"]).toEqual(["env:manual"]);
    expect(cleared.ticketFolderRoutes).toEqual({});
    expect(syncTicketFolders(cleared, [ticket({ folder: null })], newId)).toBe(cleared);
  });

  it("ignores archived tickets and tickets from servers without the folder field", () => {
    const initial = EMPTY_SIDEBAR_FOLDER_LAYOUT;
    expect(
      syncTicketFolders(
        initial,
        [
          ticket({ archivedAt: "2026-10-02", folder: "Archived" }),
          ticket({ id: "old", folder: undefined }),
        ],
        ids(),
      ),
    ).toBe(initial);
  });
});
