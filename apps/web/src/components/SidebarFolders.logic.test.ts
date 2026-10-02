import { describe, expect, it } from "vite-plus/test";

import type { SidebarListItem } from "./Sidebar.logic";
import {
  buildSidebarFolderTree,
  createSidebarFolder,
  deleteSidebarFolder,
  EMPTY_SIDEBAR_FOLDER_LAYOUT,
  filedSidebarThreadKeys,
  flattenSidebarFolders,
  moveSidebarFolder,
  moveThreadToSidebarFolder,
  planSidebarFolderDrop,
  resolveSidebarFolderDefaultProject,
  resolveSidebarFolderDropSlot,
  setSidebarFolderDefaultProject,
  sidebarSectionForListItemId,
  toggleSidebarFolderCollapsed,
  type SidebarFolderLayout,
} from "./SidebarFolders.logic";

function layoutWith(
  folders: Array<[id: string, parentId: string | null]>,
  threads: Record<string, string[]> = {},
): SidebarFolderLayout {
  return folders.reduce<SidebarFolderLayout>(
    (layout, [id, parentId]) => createSidebarFolder(layout, { id, name: id, parentId }),
    { ...EMPTY_SIDEBAR_FOLDER_LAYOUT, threadKeysByFolderId: threads },
  );
}

const order = (layout: SidebarFolderLayout) =>
  layout.folders.map((folder) => `${folder.id}<${folder.parentId ?? "root"}`);

describe("moveSidebarFolder", () => {
  const layout = layoutWith([
    ["a", null],
    ["b", null],
    ["a1", "a"],
  ]);

  it("nests a folder inside another and opens the new parent", () => {
    const collapsed = toggleSidebarFolderCollapsed(layout, "a");
    const moved = moveSidebarFolder(collapsed, "b", { kind: "inside", folderId: "a" });
    expect(order(moved)).toEqual(["a<root", "a1<a", "b<a"]);
    expect(moved.collapsedFolderIds).toEqual([]);
  });

  it("reorders among the target's siblings", () => {
    expect(order(moveSidebarFolder(layout, "b", { kind: "before", folderId: "a" }))).toEqual([
      "b<root",
      "a<root",
      "a1<a",
    ]);
    expect(order(moveSidebarFolder(layout, "a1", { kind: "after", folderId: "b" }))).toEqual([
      "a<root",
      "b<root",
      "a1<root",
    ]);
  });

  it("refuses to move a folder into its own subtree", () => {
    expect(moveSidebarFolder(layout, "a", { kind: "inside", folderId: "a1" })).toBe(layout);
    expect(moveSidebarFolder(layout, "a", { kind: "before", folderId: "a" })).toBe(layout);
  });

  it("supports unlimited depth", () => {
    let deep = layoutWith([["level0", null]]);
    for (let depth = 1; depth < 8; depth += 1) {
      deep = createSidebarFolder(deep, {
        id: `level${depth}`,
        name: `level${depth}`,
        parentId: `level${depth - 1}`,
      });
    }
    expect(flattenSidebarFolders(deep).at(-1)).toMatchObject({
      depth: 7,
      path: "level0 / level1 / level2 / level3 / level4 / level5 / level6 / level7",
    });
  });
});

describe("deleteSidebarFolder", () => {
  it("removes the subtree and releases its threads to the main list", () => {
    const layout = layoutWith(
      [
        ["a", null],
        ["a1", "a"],
        ["b", null],
      ],
      { a: ["t1"], a1: ["t2"], b: ["t3"] },
    );
    const deleted = deleteSidebarFolder(layout, "a");
    expect(order(deleted)).toEqual(["b<root"]);
    expect(deleted.threadKeysByFolderId).toEqual({ b: ["t3"] });
  });
});

describe("moveThreadToSidebarFolder", () => {
  const layout = layoutWith(
    [
      ["a", null],
      ["b", null],
    ],
    { a: ["t1", "t2"], b: ["t3"] },
  );

  it("keeps a thread in exactly one folder", () => {
    const moved = moveThreadToSidebarFolder(layout, "t1", { folderId: "b", position: "start" });
    expect(moved.threadKeysByFolderId).toEqual({ a: ["t2"], b: ["t1", "t3"] });
  });

  it("places a thread next to another thread", () => {
    const moved = moveThreadToSidebarFolder(layout, "t1", {
      folderId: "a",
      position: "after",
      threadKey: "t2",
    });
    expect(moved.threadKeysByFolderId.a).toEqual(["t2", "t1"]);
  });

  it("unfiles with a null target", () => {
    expect(moveThreadToSidebarFolder(layout, "t3", null).threadKeysByFolderId.b).toEqual([]);
  });
});

describe("folder drops", () => {
  const layout = layoutWith(
    [
      ["a", null],
      ["a1", "a"],
    ],
    { a: ["t1", "t2"] },
  );
  const rect = { top: 100, height: 30 };

  it("splits a folder header into reorder and nest zones for folders", () => {
    const source = { kind: "folder", folderId: "x" } as const;
    const over = { kind: "folder", folderId: "a" } as const;
    expect(resolveSidebarFolderDropSlot({ over, source, pointerY: 102, rect })).toMatchObject({
      zone: "before",
    });
    expect(resolveSidebarFolderDropSlot({ over, source, pointerY: 115, rect })).toMatchObject({
      zone: "inside",
    });
    expect(resolveSidebarFolderDropSlot({ over, source, pointerY: 128, rect })).toMatchObject({
      zone: "after",
    });
  });

  it("files a thread into any part of a folder header", () => {
    const slot = resolveSidebarFolderDropSlot({
      over: { kind: "folder", folderId: "a1" },
      source: { kind: "thread", threadKey: "t9" },
      pointerY: 101,
      rect,
    });
    expect(
      planSidebarFolderDrop({ layout, source: { kind: "thread", threadKey: "t9" }, slot }),
    ).toEqual({
      kind: "file-thread",
      threadKey: "t9",
      target: { folderId: "a1", position: "start" },
    });
  });

  it("drops a thread beside a filed thread in that thread's folder", () => {
    expect(
      planSidebarFolderDrop({
        layout,
        source: { kind: "thread", threadKey: "t9" },
        slot: { kind: "thread", threadKey: "t2", zone: "before" },
      }),
    ).toEqual({
      kind: "file-thread",
      threadKey: "t9",
      target: { folderId: "a", position: "before", threadKey: "t2" },
    });
  });

  it("rejects dropping a folder into its own subtree", () => {
    expect(
      planSidebarFolderDrop({
        layout,
        source: { kind: "folder", folderId: "a" },
        slot: { kind: "folder", folderId: "a1", zone: "inside" },
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("sidebarSectionForListItemId", () => {
  const items: SidebarListItem[] = [
    { kind: "marker", marker: "pinned-header" },
    { kind: "thread", key: "env:p", section: "pinned" },
    { kind: "marker", marker: "pinned-divider" },
    { kind: "marker", marker: "active-placeholder" },
    { kind: "thread", key: "env:a", section: "active" },
    { kind: "marker", marker: "settled-header" },
    { kind: "marker", marker: "settled-placeholder" },
  ];

  it("reads the section from rows and the markers around them", () => {
    expect(sidebarSectionForListItemId(items, "sidebar-marker-pinned-header")).toBe("pinned");
    expect(sidebarSectionForListItemId(items, "env:a")).toBe("active");
    expect(sidebarSectionForListItemId(items, "sidebar-marker-active-placeholder")).toBe("active");
    expect(sidebarSectionForListItemId(items, "sidebar-marker-settled-header")).toBe("settled");
    expect(sidebarSectionForListItemId(items, "unknown")).toBeNull();
  });
});

describe("buildSidebarFolderTree", () => {
  type Thread = { key: string; settled?: boolean };
  const threads = (keys: string[]) =>
    new Map(keys.map((key) => [key, { key, settled: key.startsWith("s") }] as const));
  const build = (layout: SidebarFolderLayout, visible: string[]) =>
    buildSidebarFolderTree<Thread>({
      layout,
      threadByKey: threads(visible),
      sectionOf: (thread) => (thread.settled ? "settled" : "active"),
      hideEmptyFolders: false,
    });

  it("renders subfolders before a folder's own threads", () => {
    const layout = layoutWith(
      [
        ["a", null],
        ["a1", "a"],
      ],
      { a: ["t1"], a1: ["s2"] },
    );
    const tree = build(layout, ["t1", "s2"]);
    expect(tree.renderedThreads.map((thread) => thread.key)).toEqual(["s2", "t1"]);
    expect(tree.settledKeys).toEqual(new Set(["s2"]));
    expect(tree.roots[0]!.subtreeThreads).toHaveLength(2);
  });

  it("groups settled threads last in each folder and keeps traversal in visual order", () => {
    const layout = layoutWith(
      [
        ["a", null],
        ["a1", "a"],
      ],
      { a: ["s1", "t1", "s2", "t2"], a1: ["s3", "t3"] },
    );
    const tree = build(layout, ["s1", "t1", "s2", "t2", "s3", "t3"]);
    expect(tree.roots[0]!.rows.map((row) => row.key)).toEqual(["t1", "t2", "s1", "s2"]);
    expect(tree.roots[0]!.children[0]!.rows.map((row) => row.key)).toEqual(["t3", "s3"]);
    expect(tree.renderedThreads.map((thread) => thread.key)).toEqual([
      "t3",
      "s3",
      "t1",
      "t2",
      "s1",
      "s2",
    ]);
    expect(layout.threadKeysByFolderId.a).toEqual(["s1", "t1", "s2", "t2"]);
  });

  it("returns an unsettled thread to its saved position among the other active threads", () => {
    const layout = layoutWith([["a", null]], { a: ["t1", "s1", "t2"] });
    const threadByKey = threads(["t1", "s1", "t2"]);
    threadByKey.set("s1", { key: "s1", settled: false });
    const tree = buildSidebarFolderTree({
      layout,
      threadByKey,
      sectionOf: (thread) => (thread.settled ? "settled" : "active"),
      hideEmptyFolders: false,
    });
    expect(tree.renderedThreads.map((thread) => thread.key)).toEqual(["t1", "s1", "t2"]);
    expect(tree.settledKeys.size).toBe(0);
  });

  it("hides every nested thread under a collapsed folder, at any depth", () => {
    const layout = layoutWith(
      [
        ["a", null],
        ["a1", "a"],
        ["a2", "a1"],
      ],
      { a: ["t1"], a1: ["t2"], a2: ["t3"] },
    );
    const collapsedRoot = build(toggleSidebarFolderCollapsed(layout, "a"), ["t1", "t2", "t3"]);
    expect(collapsedRoot.roots[0]).toMatchObject({ collapsed: true, children: [], rows: [] });
    expect(collapsedRoot.renderedThreads).toEqual([]);
    // The header count still covers the hidden subtree.
    expect(collapsedRoot.roots[0]!.subtreeThreads).toHaveLength(3);

    const collapsedMiddle = build(toggleSidebarFolderCollapsed(layout, "a1"), ["t1", "t2", "t3"]);
    expect(collapsedMiddle.renderedThreads.map((thread) => thread.key)).toEqual(["t1"]);
  });

  it("skips filed keys whose threads are not visible", () => {
    const layout = layoutWith([["a", null]], { a: ["gone", "t1"] });
    expect(build(layout, ["t1"]).visibleThreadCount).toBe(1);
  });

  it("hides empty folders while a project scope is active", () => {
    const layout = layoutWith(
      [
        ["a", null],
        ["b", null],
      ],
      { a: ["t1"] },
    );
    const tree = buildSidebarFolderTree<Thread>({
      layout,
      threadByKey: threads(["t1"]),
      sectionOf: () => "active",
      hideEmptyFolders: true,
    });
    expect(tree.roots.map((node) => node.folder.id)).toEqual(["a"]);
  });
});

describe("filedSidebarThreadKeys", () => {
  it("leaves pinned threads in the main list", () => {
    const layout = layoutWith([["a", null]], { a: ["t1", "t2"] });
    const filed = filedSidebarThreadKeys(
      layout,
      [
        { key: "t1", pinnedAt: null },
        { key: "t2", pinnedAt: "2026-09-27T00:00:00.000Z" },
        { key: "t3", pinnedAt: null },
      ],
      (thread) => thread.key,
    );
    expect(filed).toEqual(new Set(["t1"]));
  });
});

describe("resolveSidebarFolderDefaultProject", () => {
  const layout = layoutWith([
    ["a", null],
    ["a1", "a"],
    ["a2", "a1"],
    ["b", null],
  ]);

  it("inherits the nearest ancestor's default", () => {
    const withDefault = setSidebarFolderDefaultProject(layout, "a", "project-a");
    expect(resolveSidebarFolderDefaultProject(withDefault, "a")).toEqual({
      projectKey: "project-a",
      inheritedFrom: null,
    });
    expect(resolveSidebarFolderDefaultProject(withDefault, "a2")).toMatchObject({
      projectKey: "project-a",
      inheritedFrom: { id: "a" },
    });
    expect(resolveSidebarFolderDefaultProject(withDefault, "b")).toBeNull();
  });

  it("lets a subfolder override and clear back to inheriting", () => {
    const overridden = setSidebarFolderDefaultProject(
      setSidebarFolderDefaultProject(layout, "a", "project-a"),
      "a1",
      "project-b",
    );
    expect(resolveSidebarFolderDefaultProject(overridden, "a2")?.projectKey).toBe("project-b");
    const cleared = setSidebarFolderDefaultProject(overridden, "a1", null);
    expect(resolveSidebarFolderDefaultProject(cleared, "a2")?.projectKey).toBe("project-a");
  });
});
