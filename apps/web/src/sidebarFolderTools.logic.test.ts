import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  createSidebarFolder,
  EMPTY_SIDEBAR_FOLDER_LAYOUT,
} from "./components/SidebarFolders.logic";
import { useSidebarFolderStore } from "./sidebarFolderStore";
import { executeSidebarFolderAction, listSidebarFolderSummaries } from "./sidebarFolderTools.logic";

beforeEach(() => {
  useSidebarFolderStore.getState().syncTicketFolders([]);
  useSidebarFolderStore.setState({
    ...EMPTY_SIDEBAR_FOLDER_LAYOUT,
    ticketFolderRoutes: {},
    pendingFolderPaths: {},
  });
});

describe("sidebar folder agent actions", () => {
  it("lists empty and nested folders even when collapsed or settled", () => {
    const layout = createSidebarFolder(
      createSidebarFolder(
        createSidebarFolder(EMPTY_SIDEBAR_FOLDER_LAYOUT, {
          id: "parent",
          name: "Project",
          parentId: null,
        }),
        { id: "child", name: "Feature", parentId: "parent" },
      ),
      { id: "empty", name: "Empty", parentId: null },
    );
    const summaries = listSidebarFolderSummaries({
      ...layout,
      threadKeysByFolderId: { parent: ["local:a"], child: ["remote:b"] },
      collapsedFolderIds: ["parent"],
      settledFolderIds: ["empty"],
    });
    expect(
      summaries.map(({ id, path, threadCount, subtreeThreadCount, settled }) => ({
        id,
        path,
        threadCount,
        subtreeThreadCount,
        settled,
      })),
    ).toEqual([
      { id: "parent", path: "Project", threadCount: 1, subtreeThreadCount: 2, settled: false },
      {
        id: "child",
        path: "Project/Feature",
        threadCount: 1,
        subtreeThreadCount: 1,
        settled: false,
      },
      { id: "empty", path: "Empty", threadCount: 0, subtreeThreadCount: 0, settled: true },
    ]);
  });

  it("deletes an empty leftover after its ticket stops filing there", () => {
    const store = useSidebarFolderStore;
    const ticket = { id: "ticket", folder: "Old pass", archivedAt: null, threadKeys: [] };
    store.getState().syncTicketFolders([ticket]);
    const folderId = store.getState().folders[0]!.id;
    store.getState().syncTicketFolders([{ ...ticket, folder: null }]);
    expect(store.getState().folders).toHaveLength(1);
    expect(executeSidebarFolderAction(store.getState(), { type: "delete", folderId })).toEqual({
      result: {
        type: "deleted",
        deletedFolderIds: [folderId],
        releasedThreadCount: 0,
        queuedTicketFolderClears: 0,
        queuedTaskFolderClears: 0,
      },
    });
    expect(store.getState().folders).toEqual([]);
  });

  it("removes descendants, preserves chats, and queues ticket and task routing cleanup through the existing store", () => {
    const store = useSidebarFolderStore;
    store.getState().syncTicketFolders([
      { id: "ticket", folder: "Project/Feature", archivedAt: null, threadKeys: ["local:chat"] },
      { id: "task:scheduled", folder: "Project", archivedAt: null, threadKeys: ["remote:run"] },
      { id: "other", folder: "Keep", archivedAt: null, threadKeys: ["local:other"] },
    ]);
    const parentId = store.getState().folders.find((folder) => folder.name === "Project")!.id;
    const listed = listSidebarFolderSummaries(store.getState()).find(
      (folder) => folder.id === parentId,
    );
    expect(listed).toMatchObject({ subtreeThreadCount: 2, routedTickets: 1, routedTasks: 1 });
    const result = executeSidebarFolderAction(store.getState(), {
      type: "delete",
      folderId: parentId,
    });
    expect(result.result).toMatchObject({
      type: "deleted",
      releasedThreadCount: 2,
      queuedTicketFolderClears: 1,
      queuedTaskFolderClears: 1,
    });
    expect(store.getState().folders.map((folder) => folder.name)).toEqual(["Keep"]);
    expect(Object.values(store.getState().threadKeysByFolderId).flat()).toEqual(["local:other"]);
    expect(store.getState().pendingFolderPaths).toMatchObject({
      ticket: { path: null },
      "task:scheduled": { path: null },
    });
    expect(store.getState().ticketFolderRoutes?.other).toBeDefined();
  });

  it("reports a missing folder without changing the sidebar", () => {
    const store = useSidebarFolderStore;
    store.getState().createFolder({ name: "Keep", parentId: null });
    const before = store.getState();
    expect(
      executeSidebarFolderAction(before, { type: "delete", folderId: "missing" }).error?.code,
    ).toBe("not-found");
    expect(store.getState()).toBe(before);
  });
});
