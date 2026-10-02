import type { Ticket } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_SIDEBAR_FOLDER_LAYOUT,
  flattenSidebarFolders,
  moveThreadToSidebarFolder,
  renameSidebarFolder,
} from "../SidebarFolders.logic";
import { syncTicketFolders } from "./ticketFolders.logic";

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

  it("preserves manual filing and folder renames across saved layouts and subsequent sessions", () => {
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
    expect(updated.folders[1]!.name).toBe("Kids venues");
    expect(updated.threadKeysByFolderId["folder-1"]).toEqual(["env:manual"]);
    expect(updated.threadKeysByFolderId["folder-2"]).toEqual(["env:review"]);
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
