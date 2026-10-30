import { beforeEach, describe, expect, it } from "@effect/vitest";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  createSidebarFolder,
  EMPTY_SIDEBAR_FOLDER_LAYOUT,
} from "./components/SidebarFolders.logic";
import { useSidebarFolderStore } from "./sidebarFolderStore";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import {
  executeClaimedSidebarFolderAction,
  executeSidebarFolderAction,
  filedThreadExists,
  listSidebarFolderSummaries,
} from "./sidebarFolderTools.logic";

const isExistingThread = (key: string) =>
  !["local:deleted", "local:archived", "offline:missing"].includes(key);

beforeEach(() => {
  useSidebarFolderStore.getState().syncTicketFolders([]);
  useSidebarFolderStore.setState({
    ...EMPTY_SIDEBAR_FOLDER_LAYOUT,
    ticketFolderRoutes: {},
    pendingFolderPaths: {},
  });
});

describe("sidebar folder agent actions", () => {
  it("creates a nested path once and returns the existing leaf on retry", () => {
    const store = useSidebarFolderStore;

    const first = executeSidebarFolderAction(
      store.getState(),
      { type: "create", path: "t3-code / other-projects-findings" },
      isExistingThread,
    );
    expect(first.result).toMatchObject({
      type: "folder-created",
      path: "t3-code/other-projects-findings",
      createdFolderIds: expect.any(Array),
    });
    expect(store.getState().folders.map(({ name }) => name)).toEqual([
      "t3-code",
      "other-projects-findings",
    ]);
    const folderId = first.result?.type === "folder-created" ? first.result.folderId : "";
    expect(first.result?.type === "folder-created" && first.result.createdFolderIds).toHaveLength(
      2,
    );

    expect(
      executeSidebarFolderAction(
        store.getState(),
        { type: "create", path: "t3-code/other-projects-findings" },
        isExistingThread,
      ),
    ).toEqual({
      result: {
        type: "folder-created",
        folderId,
        path: "t3-code/other-projects-findings",
        createdFolderIds: [],
      },
    });
    expect(store.getState().folders).toHaveLength(2);
  });

  it("rejects a path with an empty segment without creating folders", () => {
    const store = useSidebarFolderStore;
    expect(
      executeSidebarFolderAction(
        store.getState(),
        { type: "create", path: "t3-code//findings" },
        isExistingThread,
      ).error?.code,
    ).toBe("invalid-path");
    expect(store.getState().folders).toEqual([]);
  });

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
    const summaries = listSidebarFolderSummaries(
      {
        ...layout,
        threadKeysByFolderId: { parent: ["local:a"], child: ["remote:b"] },
        collapsedFolderIds: ["parent"],
        settledFolderIds: ["empty"],
      },
      isExistingThread,
    );
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

  it("counts filed chats a shell leaves out as older settled, but not removed ones", () => {
    const layout = createSidebarFolder(EMPTY_SIDEBAR_FOLDER_LAYOUT, {
      id: "ticket",
      name: "SALON-61",
      parentId: null,
    });
    const exists = filedThreadExists(
      (ref) => (ref.threadId === "loaded" ? { archivedAt: null, deletedAt: null } : null),
      (environmentId) =>
        environmentId === "offline"
          ? null
          : {
              snapshot: Option.some(environmentId === "cut" ? { olderSettled: {} } : {}),
              removedAt: new Map([[ThreadId.make("archived"), 3]]),
            },
    );
    const [summary] = listSidebarFolderSummaries(
      {
        ...layout,
        threadKeysByFolderId: {
          ticket: ["cut:loaded", "cut:older", "cut:archived", "whole:gone", "offline:older"],
        },
      },
      exists,
    );
    expect(summary).toMatchObject({ threadCount: 2, subtreeThreadCount: 2 });
  });

  it("deletes an empty leftover after its ticket stops filing there", () => {
    const store = useSidebarFolderStore;
    const ticket = { id: "ticket", folder: "Old pass", archivedAt: null, threadKeys: [] };
    store.getState().syncTicketFolders([ticket]);
    const folderId = store.getState().folders[0]!.id;
    store.getState().syncTicketFolders([{ ...ticket, folder: null }]);
    expect(store.getState().folders).toHaveLength(1);
    expect(
      executeSidebarFolderAction(store.getState(), { type: "delete", folderId }, isExistingThread),
    ).toEqual({
      result: {
        type: "deleted",
        deletedFolderIds: [folderId],
        releasedThreadCount: 0,
        queuedTicketFolderClears: 0,
        queuedTaskFolderClears: 0,
        queuedChatFolderClears: 0,
      },
    });
    expect(store.getState().folders).toEqual([]);
  });

  it("changes and clears a folder image through the existing store", () => {
    const store = useSidebarFolderStore;
    const folderId = store.getState().createFolder({ name: "Images", parentId: null });
    const icon = { kind: "image", dataUrl: "data:image/png;base64,aWNvbg==" } as const;

    expect(
      executeSidebarFolderAction(
        store.getState(),
        { type: "set-icon", folderId, icon },
        isExistingThread,
      ),
    ).toEqual({ result: { type: "folder-icon-updated", folderId, icon } });
    expect(store.getState().folders.find((folder) => folder.id === folderId)?.icon).toEqual(icon);
    expect(listSidebarFolderSummaries(store.getState(), isExistingThread)[0]?.icon).toEqual(icon);

    expect(
      executeSidebarFolderAction(
        store.getState(),
        { type: "set-icon", folderId, icon: null },
        isExistingThread,
      ),
    ).toEqual({
      result: { type: "folder-icon-updated", folderId, icon: null },
    });
    expect(store.getState().folders.find((folder) => folder.id === folderId)?.icon).toBeNull();
  });

  it("removes descendants, preserves chats, and queues ticket, task, and chat routing cleanup through the existing store", () => {
    const store = useSidebarFolderStore;
    store.getState().syncTicketFolders([
      { id: "ticket", folder: "Project/Feature", archivedAt: null, threadKeys: ["local:chat"] },
      { id: "task:scheduled", folder: "Project", archivedAt: null, threadKeys: ["remote:run"] },
      {
        id: "chat:review",
        folder: "Project/Reviews",
        archivedAt: null,
        threadKeys: ["local:review"],
      },
      { id: "other", folder: "Keep", archivedAt: null, threadKeys: ["local:other"] },
    ]);
    const parentId = store.getState().folders.find((folder) => folder.name === "Project")!.id;
    const listed = listSidebarFolderSummaries(store.getState(), isExistingThread).find(
      (folder) => folder.id === parentId,
    );
    expect(listed).toMatchObject({
      subtreeThreadCount: 3,
      routedTickets: 1,
      routedTasks: 1,
      routedChats: 1,
    });
    const result = executeSidebarFolderAction(
      store.getState(),
      {
        type: "delete",
        folderId: parentId,
      },
      isExistingThread,
    );
    expect(result.result).toMatchObject({
      type: "deleted",
      releasedThreadCount: 3,
      queuedTicketFolderClears: 1,
      queuedTaskFolderClears: 1,
      queuedChatFolderClears: 1,
    });
    expect(store.getState().folders.map((folder) => folder.name)).toEqual(["Keep"]);
    expect(Object.values(store.getState().threadKeysByFolderId).flat()).toEqual(["local:other"]);
    expect(store.getState().pendingFolderPaths).toMatchObject({
      ticket: { path: null },
      "task:scheduled": { path: null },
      "chat:review": { path: null },
    });
    expect(store.getState().ticketFolderRoutes?.other).toBeDefined();
  });

  it("reports a missing folder without changing the sidebar", () => {
    const store = useSidebarFolderStore;
    store.getState().createFolder({ name: "Keep", parentId: null });
    const before = store.getState();
    expect(
      executeSidebarFolderAction(before, { type: "delete", folderId: "missing" }, isExistingThread)
        .error?.code,
    ).toBe("not-found");
    expect(store.getState()).toBe(before);
  });

  it("moves an existing thread into a folder and back to the main list", () => {
    const store = useSidebarFolderStore;
    const folderId = store.getState().createFolder({ name: "Scheduled tasks", parentId: null });
    const thread = scopeThreadRef(
      EnvironmentId.make("environment"),
      ThreadId.make("thread:shared"),
    );
    const threadKey = scopedThreadKey(thread);
    const exists = (key: string) => key === threadKey;

    expect(
      executeSidebarFolderAction(
        store.getState(),
        { type: "move-thread", thread, folderId },
        exists,
      ),
    ).toEqual({ result: { type: "thread-moved", thread, folderId } });
    expect(store.getState().threadKeysByFolderId[folderId]).toEqual([threadKey]);

    expect(
      executeSidebarFolderAction(
        store.getState(),
        { type: "move-thread", thread, folderId: null },
        exists,
      ),
    ).toEqual({ result: { type: "thread-moved", thread, folderId: null } });
    expect(store.getState().threadKeysByFolderId[folderId]).toEqual([]);
  });

  it("refuses to file a missing thread or use a missing folder", () => {
    const store = useSidebarFolderStore;
    const thread = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread"));
    const missingThread = executeSidebarFolderAction(
      store.getState(),
      { type: "move-thread", thread, folderId: null },
      () => false,
    );
    expect(missingThread.error?.code).toBe("thread-not-found");
    const missingFolder = executeSidebarFolderAction(
      store.getState(),
      { type: "move-thread", thread, folderId: "missing" },
      () => true,
    );
    expect(missingFolder.error?.code).toBe("not-found");
  });

  it.effect("settles a top-level folder and all chats in its subtree", () =>
    Effect.gen(function* () {
      const store = useSidebarFolderStore;
      const parentId = store.getState().createFolder({ name: "Project", parentId: null });
      const childId = store.getState().createFolder({ name: "Feature", parentId });
      store.setState({
        threadKeysByFolderId: {
          [parentId]: ["local:parent"],
          [childId]: ["local:child"],
        },
      });
      let requested: readonly string[] = [];
      const result = yield* executeClaimedSidebarFolderAction(
        Effect.succeed(true),
        store.getState,
        { type: "set-settled", folderId: parentId, settled: true },
        isExistingThread,
        (threadKeys) =>
          Effect.sync(() => {
            requested = threadKeys;
            return true;
          }),
      );
      expect(result).toEqual({
        result: { type: "folder-settled", folderId: parentId, settled: true },
      });
      expect(store.getState().settledFolderIds).toEqual([parentId]);
      expect(requested).toEqual(["local:parent", "local:child"]);
    }),
  );

  it("settles and un-settles a nested folder without changing its parent or filing", () => {
    const store = useSidebarFolderStore;
    const parentId = store.getState().createFolder({ name: "Project", parentId: null });
    const childId = store.getState().createFolder({ name: "Feature", parentId });
    store.setState({ threadKeysByFolderId: { [childId]: ["local:chat"] } });
    expect(
      executeSidebarFolderAction(
        store.getState(),
        { type: "set-settled", folderId: childId, settled: true },
        isExistingThread,
      ),
    ).toEqual({
      result: { type: "folder-settled", folderId: childId, settled: true },
    });
    expect(store.getState().settledFolderIds).toEqual([childId]);
    expect(listSidebarFolderSummaries(store.getState(), isExistingThread)).toEqual([
      expect.objectContaining({ id: parentId, settled: false }),
      expect.objectContaining({ id: childId, settled: true }),
    ]);
    expect(
      executeSidebarFolderAction(
        store.getState(),
        { type: "set-settled", folderId: childId, settled: false },
        isExistingThread,
      ),
    ).toEqual({ result: { type: "folder-settled", folderId: childId, settled: false } });
    expect(store.getState().settledFolderIds).toEqual([]);
    expect(store.getState().threadKeysByFolderId).toEqual({ [childId]: ["local:chat"] });
  });

  it.effect("settles only a nested folder's subtree before marking that folder settled", () =>
    Effect.gen(function* () {
      const store = useSidebarFolderStore;
      const parentId = store.getState().createFolder({ name: "Project", parentId: null });
      const childId = store.getState().createFolder({ name: "Feature", parentId });
      const grandchildId = store.getState().createFolder({ name: "Work", parentId: childId });
      const siblingId = store.getState().createFolder({ name: "Other", parentId });
      store.setState({
        threadKeysByFolderId: {
          [parentId]: ["local:parent"],
          [childId]: ["local:child"],
          [grandchildId]: ["remote:grandchild"],
          [siblingId]: ["local:sibling"],
        },
      });
      let requested: readonly string[] = [];
      const result = yield* executeClaimedSidebarFolderAction(
        Effect.succeed(true),
        store.getState,
        { type: "set-settled", folderId: childId, settled: true },
        isExistingThread,
        (keys) =>
          Effect.sync(() => {
            expect(store.getState().settledFolderIds).toEqual([]);
            requested = keys;
            return true;
          }),
      );
      expect(result).toEqual({
        result: { type: "folder-settled", folderId: childId, settled: true },
      });
      expect(requested).toEqual(["local:child", "remote:grandchild"]);
      expect(store.getState().settledFolderIds).toEqual([childId]);
    }),
  );

  it.effect("leaves a nested folder active when settling its chats fails", () =>
    Effect.gen(function* () {
      const store = useSidebarFolderStore;
      const parentId = store.getState().createFolder({ name: "Project", parentId: null });
      const childId = store.getState().createFolder({ name: "Feature", parentId });
      store.setState({ threadKeysByFolderId: { [childId]: ["local:chat"] } });
      const result = yield* executeClaimedSidebarFolderAction(
        Effect.succeed(true),
        store.getState,
        { type: "set-settled", folderId: childId, settled: true },
        isExistingThread,
        () => Effect.succeed(false),
      );
      expect(result?.error?.code).toBe("thread-settlement-failed");
      expect(store.getState().settledFolderIds).toEqual([]);
    }),
  );
});

it("counts only existing, unarchived chats when listing and releasing a folder", () => {
  const store = useSidebarFolderStore;
  const folderId = store.getState().createFolder({ name: "Old", parentId: null });
  store.setState({
    threadKeysByFolderId: {
      [folderId]: ["local:chat", "local:deleted", "local:archived", "offline:missing"],
    },
  });
  expect(listSidebarFolderSummaries(store.getState(), isExistingThread)[0]).toMatchObject({
    threadCount: 1,
    subtreeThreadCount: 1,
  });
  expect(
    executeSidebarFolderAction(store.getState(), { type: "delete", folderId }, isExistingThread)
      .result,
  ).toMatchObject({ releasedThreadCount: 1 });
  expect(store.getState().folders).toEqual([]);
});

it.effect("does not apply a delete after its queued request expires", () =>
  Effect.gen(function* () {
    const store = useSidebarFolderStore;
    const folderId = store.getState().createFolder({ name: "Keep", parentId: null });
    const before = store.getState();
    const result = yield* executeClaimedSidebarFolderAction(
      Effect.succeed(false),
      store.getState,
      { type: "delete", folderId },
      isExistingThread,
    );
    expect(result).toBeNull();
    expect(store.getState()).toBe(before);
  }),
);

it.effect("leaves the folder active when one of its chats does not settle", () =>
  Effect.gen(function* () {
    const store = useSidebarFolderStore;
    const folderId = store.getState().createFolder({ name: "Project", parentId: null });
    store.setState({ threadKeysByFolderId: { [folderId]: ["local:chat"] } });
    const result = yield* executeClaimedSidebarFolderAction(
      Effect.succeed(true),
      store.getState,
      { type: "set-settled", folderId, settled: true },
      isExistingThread,
      () => Effect.succeed(false),
    );
    expect(result?.error?.code).toBe("thread-settlement-failed");
    expect(store.getState().settledFolderIds).toEqual([]);
  }),
);

it.effect("waits for the claim and reads the latest folder state before deleting", () =>
  Effect.gen(function* () {
    const store = useSidebarFolderStore;
    const folderId = store.getState().createFolder({ name: "Old", parentId: null });
    const claim = yield* Deferred.make<boolean>();
    const response = yield* executeClaimedSidebarFolderAction(
      Deferred.await(claim),
      store.getState,
      { type: "delete", folderId },
      isExistingThread,
    ).pipe(Effect.forkChild);
    expect(store.getState().folders).toHaveLength(1);
    store.getState().deleteFolder(folderId);
    store.getState().createFolder({ name: "New", parentId: null });
    yield* Deferred.succeed(claim, true);
    expect((yield* Fiber.join(response))?.error?.code).toBe("not-found");
    expect(store.getState().folders.map((folder) => folder.name)).toEqual(["New"]);
  }),
);
