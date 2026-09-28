import { sidebarMarkerId, type SidebarListItem, type SidebarSection } from "./Sidebar.logic";

/** A user folder in the sidebar. Sibling order is the order in `folders`. */
export interface SidebarFolder {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  /** Logical project key new chats start in. Unset inherits the parent's. */
  readonly defaultProjectKey?: string | null | undefined;
}

/** Client-local folder layout. Thread keys are scoped thread keys, so one
    layout can hold threads from every environment. */
export interface SidebarFolderLayout {
  readonly folders: readonly SidebarFolder[];
  /** Ordered thread keys per folder. A thread lives in at most one folder. */
  readonly threadKeysByFolderId: Readonly<Record<string, readonly string[]>>;
  readonly collapsedFolderIds: readonly string[];
}

export const EMPTY_SIDEBAR_FOLDER_LAYOUT: SidebarFolderLayout = {
  folders: [],
  threadKeysByFolderId: {},
  collapsedFolderIds: [],
};

export function folderIdByThreadKey(layout: SidebarFolderLayout): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const [folderId, threadKeys] of Object.entries(layout.threadKeysByFolderId)) {
    for (const threadKey of threadKeys) mapping.set(threadKey, folderId);
  }
  return mapping;
}

/** The folder and every folder nested beneath it. */
export function folderSubtreeIds(layout: SidebarFolderLayout, folderId: string): Set<string> {
  const subtree = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of layout.folders) {
      if (folder.parentId !== null && subtree.has(folder.parentId) && !subtree.has(folder.id)) {
        subtree.add(folder.id);
        grew = true;
      }
    }
  }
  return subtree;
}

/** "Parent / Child" labels in tree order, for menus that list every folder. */
export function flattenSidebarFolders(
  layout: SidebarFolderLayout,
): Array<{ readonly folder: SidebarFolder; readonly path: string; readonly depth: number }> {
  const result: Array<{ folder: SidebarFolder; path: string; depth: number }> = [];
  const visit = (parentId: string | null, prefix: string, depth: number) => {
    for (const folder of layout.folders) {
      if (folder.parentId !== parentId) continue;
      const path = prefix ? `${prefix} / ${folder.name}` : folder.name;
      result.push({ folder, path, depth });
      visit(folder.id, path, depth + 1);
    }
  };
  visit(null, "", 0);
  return result;
}

export function createSidebarFolder(
  layout: SidebarFolderLayout,
  folder: SidebarFolder,
): SidebarFolderLayout {
  if (folder.parentId !== null && !layout.folders.some(({ id }) => id === folder.parentId)) {
    return layout;
  }
  return {
    ...layout,
    folders: [...layout.folders, folder],
    // A new subfolder should be visible, so its parent opens.
    collapsedFolderIds: layout.collapsedFolderIds.filter((id) => id !== folder.parentId),
  };
}

export function renameSidebarFolder(
  layout: SidebarFolderLayout,
  folderId: string,
  name: string,
): SidebarFolderLayout {
  const trimmed = name.trim();
  if (trimmed.length === 0) return layout;
  return {
    ...layout,
    folders: layout.folders.map((folder) =>
      folder.id === folderId ? { ...folder, name: trimmed } : folder,
    ),
  };
}

export function setSidebarFolderDefaultProject(
  layout: SidebarFolderLayout,
  folderId: string,
  projectKey: string | null,
): SidebarFolderLayout {
  return {
    ...layout,
    folders: layout.folders.map((folder) =>
      folder.id === folderId ? { ...folder, defaultProjectKey: projectKey } : folder,
    ),
  };
}

/** The project new chats in this folder start in: its own default, else the
    nearest ancestor's. */
export function resolveSidebarFolderDefaultProject(
  layout: SidebarFolderLayout,
  folderId: string,
): { readonly projectKey: string; readonly inheritedFrom: SidebarFolder | null } | null {
  const byId = new Map(layout.folders.map((folder) => [folder.id, folder]));
  let folder = byId.get(folderId);
  const seen = new Set<string>();
  while (folder !== undefined && !seen.has(folder.id)) {
    seen.add(folder.id);
    if (folder.defaultProjectKey) {
      return {
        projectKey: folder.defaultProjectKey,
        inheritedFrom: folder.id === folderId ? null : folder,
      };
    }
    folder = folder.parentId === null ? undefined : byId.get(folder.parentId);
  }
  return null;
}

/** Deletes the folder and its subfolders. Their threads return to the
    regular list; threads themselves are never touched. */
export function deleteSidebarFolder(
  layout: SidebarFolderLayout,
  folderId: string,
): SidebarFolderLayout {
  const removed = folderSubtreeIds(layout, folderId);
  return {
    folders: layout.folders.filter((folder) => !removed.has(folder.id)),
    threadKeysByFolderId: Object.fromEntries(
      Object.entries(layout.threadKeysByFolderId).filter(([id]) => !removed.has(id)),
    ),
    collapsedFolderIds: layout.collapsedFolderIds.filter((id) => !removed.has(id)),
  };
}

export function toggleSidebarFolderCollapsed(
  layout: SidebarFolderLayout,
  folderId: string,
): SidebarFolderLayout {
  return {
    ...layout,
    collapsedFolderIds: layout.collapsedFolderIds.includes(folderId)
      ? layout.collapsedFolderIds.filter((id) => id !== folderId)
      : [...layout.collapsedFolderIds, folderId],
  };
}

export type SidebarFolderMoveTarget =
  | { readonly kind: "inside"; readonly folderId: string }
  | { readonly kind: "before" | "after"; readonly folderId: string }
  | { readonly kind: "root" };

/** Moves a folder (with its subtree). Moving a folder into itself or one of
    its own subfolders is a no-op. */
export function moveSidebarFolder(
  layout: SidebarFolderLayout,
  folderId: string,
  target: SidebarFolderMoveTarget,
): SidebarFolderLayout {
  const moving = layout.folders.find((folder) => folder.id === folderId);
  if (moving === undefined) return layout;
  if (target.kind !== "root" && folderSubtreeIds(layout, folderId).has(target.folderId)) {
    return layout;
  }
  const rest = layout.folders.filter((folder) => folder.id !== folderId);
  if (target.kind === "root" || target.kind === "inside") {
    const parentId = target.kind === "root" ? null : target.folderId;
    if (parentId !== null && !rest.some((folder) => folder.id === parentId)) return layout;
    return {
      ...layout,
      folders: [...rest, { ...moving, parentId }],
      collapsedFolderIds: layout.collapsedFolderIds.filter((id) => id !== parentId),
    };
  }
  const anchorIndex = rest.findIndex((folder) => folder.id === target.folderId);
  if (anchorIndex === -1) return layout;
  const anchor = rest[anchorIndex]!;
  const insertAt = target.kind === "before" ? anchorIndex : anchorIndex + 1;
  return {
    ...layout,
    folders: [
      ...rest.slice(0, insertAt),
      { ...moving, parentId: anchor.parentId },
      ...rest.slice(insertAt),
    ],
  };
}

export type SidebarThreadFolderTarget =
  | { readonly folderId: string; readonly position: "start" | "end" }
  | {
      readonly folderId: string;
      readonly position: "before" | "after";
      readonly threadKey: string;
    };

/** Files a thread into a folder (or removes it from every folder with null). */
export function moveThreadToSidebarFolder(
  layout: SidebarFolderLayout,
  threadKey: string,
  target: SidebarThreadFolderTarget | null,
): SidebarFolderLayout {
  if (target !== null && !layout.folders.some((folder) => folder.id === target.folderId)) {
    return layout;
  }
  const withoutThread = Object.fromEntries(
    Object.entries(layout.threadKeysByFolderId).map(([folderId, threadKeys]) => [
      folderId,
      threadKeys.filter((key) => key !== threadKey),
    ]),
  );
  if (target === null) return { ...layout, threadKeysByFolderId: withoutThread };
  const current = withoutThread[target.folderId] ?? [];
  let insertAt = target.position === "start" ? 0 : current.length;
  if (target.position === "before" || target.position === "after") {
    const anchorIndex = current.indexOf(target.threadKey);
    if (anchorIndex !== -1) insertAt = target.position === "before" ? anchorIndex : anchorIndex + 1;
  }
  return {
    ...layout,
    threadKeysByFolderId: {
      ...withoutThread,
      [target.folderId]: [...current.slice(0, insertAt), threadKey, ...current.slice(insertAt)],
    },
  };
}

// ---------------------------------------------------------------------------
// Drag and drop

/** Folder rows and filed thread rows share the sidebar's DndContext; these
    prefixes keep their ids apart from thread keys and sidebar markers. */
const FOLDER_DND_PREFIX = "sidebar-folder:";
const FOLDER_THREAD_DND_PREFIX = "sidebar-folder-thread:";
export const SIDEBAR_FOLDER_ROOT_DND_ID = "sidebar-folder-root";

export function folderDndId(folderId: string): string {
  return `${FOLDER_DND_PREFIX}${folderId}`;
}

export function folderThreadDndId(threadKey: string): string {
  return `${FOLDER_THREAD_DND_PREFIX}${threadKey}`;
}

export type SidebarFolderDndItem =
  | { readonly kind: "folder"; readonly folderId: string }
  | { readonly kind: "thread"; readonly threadKey: string }
  | { readonly kind: "root" };

export function parseSidebarFolderDndId(id: string): SidebarFolderDndItem | null {
  if (id === SIDEBAR_FOLDER_ROOT_DND_ID) return { kind: "root" };
  if (id.startsWith(FOLDER_THREAD_DND_PREFIX)) {
    return { kind: "thread", threadKey: id.slice(FOLDER_THREAD_DND_PREFIX.length) };
  }
  if (id.startsWith(FOLDER_DND_PREFIX)) {
    return { kind: "folder", folderId: id.slice(FOLDER_DND_PREFIX.length) };
  }
  return null;
}

export type SidebarFolderDropZone = "before" | "inside" | "after";

/** Where a drop lands, read off the hovered row and the pointer. */
export type SidebarFolderDropSlot =
  | { readonly kind: "folder"; readonly folderId: string; readonly zone: SidebarFolderDropZone }
  | { readonly kind: "thread"; readonly threadKey: string; readonly zone: "before" | "after" }
  | { readonly kind: "root" };

/** The dragged thing: a folder, or a thread that may or may not be filed. */
export type SidebarFolderDragSource =
  | { readonly kind: "folder"; readonly folderId: string }
  | { readonly kind: "thread"; readonly threadKey: string };

export function resolveSidebarFolderDropSlot(input: {
  readonly over: SidebarFolderDndItem;
  readonly source: SidebarFolderDragSource;
  readonly pointerY: number | null;
  readonly rect: { readonly top: number; readonly height: number };
}): SidebarFolderDropSlot {
  const { over, source, rect } = input;
  const offset = input.pointerY === null ? rect.height / 2 : input.pointerY - rect.top;
  if (over.kind === "root") return over;
  if (over.kind === "thread") {
    return {
      kind: "thread",
      threadKey: over.threadKey,
      zone: offset < rect.height / 2 ? "before" : "after",
    };
  }
  // Threads always file into a hovered folder. Folders split the header
  // into thirds: reorder above, nest in the middle, reorder below.
  if (source.kind === "thread") return { kind: "folder", folderId: over.folderId, zone: "inside" };
  const zone: SidebarFolderDropZone =
    offset < rect.height / 3 ? "before" : offset > (rect.height * 2) / 3 ? "after" : "inside";
  return { kind: "folder", folderId: over.folderId, zone };
}

export type SidebarFolderDropPlan =
  | { readonly kind: "none" }
  | {
      readonly kind: "move-folder";
      readonly folderId: string;
      readonly target: SidebarFolderMoveTarget;
    }
  | {
      readonly kind: "file-thread";
      readonly threadKey: string;
      readonly target: SidebarThreadFolderTarget | null;
    };

export function planSidebarFolderDrop(input: {
  readonly layout: SidebarFolderLayout;
  readonly source: SidebarFolderDragSource;
  readonly slot: SidebarFolderDropSlot;
}): SidebarFolderDropPlan {
  const { layout, source, slot } = input;
  if (source.kind === "folder") {
    if (slot.kind === "thread") return { kind: "none" };
    if (slot.kind === "root") {
      return { kind: "move-folder", folderId: source.folderId, target: { kind: "root" } };
    }
    if (folderSubtreeIds(layout, source.folderId).has(slot.folderId)) return { kind: "none" };
    return {
      kind: "move-folder",
      folderId: source.folderId,
      target:
        slot.zone === "inside"
          ? { kind: "inside", folderId: slot.folderId }
          : { kind: slot.zone, folderId: slot.folderId },
    };
  }
  if (slot.kind === "root") return { kind: "none" };
  if (slot.kind === "folder") {
    return {
      kind: "file-thread",
      threadKey: source.threadKey,
      target: { folderId: slot.folderId, position: "start" },
    };
  }
  if (slot.threadKey === source.threadKey) return { kind: "none" };
  const folderId = folderIdByThreadKey(layout).get(slot.threadKey);
  if (folderId === undefined) return { kind: "none" };
  return {
    kind: "file-thread",
    threadKey: source.threadKey,
    target: { folderId, position: slot.zone, threadKey: slot.threadKey },
  };
}

/** The main-list section a sortable id sits in, for drops that carry a
    filed thread out of its folder. Mirrors the marker walk in Sidebar.logic. */
export function sidebarSectionForListItemId(
  items: readonly SidebarListItem[],
  id: string,
): SidebarSection | null {
  let section: SidebarSection = "pinned";
  for (const item of items) {
    if (item.kind === "marker") {
      if (item.marker === "pinned-divider" || item.marker === "active-placeholder") {
        section = "active";
      } else if (item.marker === "snoozed-header") section = "snoozed";
      else if (item.marker === "settled-header" || item.marker === "settled-placeholder") {
        section = "settled";
      }
      if (sidebarMarkerId(item.marker) === id) return section;
      continue;
    }
    if (item.key === id) return item.section;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering

/** Filed threads keep their lifecycle: settled and snoozed rows stay slim. */
export type SidebarFolderThreadSection = Extract<SidebarSection, "active" | "snoozed" | "settled">;

export interface SidebarFolderThreadRow<TThread> {
  readonly thread: TThread;
  readonly key: string;
  readonly section: SidebarFolderThreadSection;
}

export interface SidebarFolderTreeNode<TThread> {
  readonly folder: SidebarFolder;
  readonly depth: number;
  readonly collapsed: boolean;
  /** Subfolders to render; empty while collapsed. */
  readonly children: ReadonlyArray<SidebarFolderTreeNode<TThread>>;
  /** This folder's threads to render; empty while collapsed. */
  readonly rows: ReadonlyArray<SidebarFolderThreadRow<TThread>>;
  /** Visible threads in this folder and below, for the header rollup. */
  readonly subtreeThreads: readonly TThread[];
}

export interface SidebarFolderTree<TThread> {
  readonly roots: ReadonlyArray<SidebarFolderTreeNode<TThread>>;
  /** Rendered thread rows in visual order, for traversal and jump hints. */
  readonly renderedThreads: readonly TThread[];
  readonly settledKeys: ReadonlySet<string>;
  readonly snoozedKeys: ReadonlySet<string>;
  readonly visibleThreadCount: number;
}

/**
 * Filed threads leave the main list, except pinned ones: pinning is an
 * explicit "keep on top", so a pinned thread renders in Pinned and returns
 * to its folder when unpinned.
 */
export function filedSidebarThreadKeys<
  TThread extends { readonly pinnedAt?: string | null | undefined },
>(
  layout: SidebarFolderLayout,
  threads: readonly TThread[],
  keyOf: (thread: TThread) => string,
): Set<string> {
  const folderByThread = folderIdByThreadKey(layout);
  const filed = new Set<string>();
  if (folderByThread.size === 0) return filed;
  for (const thread of threads) {
    const key = keyOf(thread);
    if (thread.pinnedAt == null && folderByThread.has(key)) filed.add(key);
  }
  return filed;
}

export function buildSidebarFolderTree<TThread>(input: {
  readonly layout: SidebarFolderLayout;
  /** Visible (unarchived, in-scope) threads that are filed. */
  readonly threadByKey: ReadonlyMap<string, TThread>;
  readonly sectionOf: (thread: TThread) => SidebarFolderThreadSection;
  /** While a project scope is active, folders with no matching threads hide. */
  readonly hideEmptyFolders: boolean;
}): SidebarFolderTree<TThread> {
  const { layout, threadByKey } = input;
  const collapsed = new Set(layout.collapsedFolderIds);
  const renderedThreads: TThread[] = [];
  const settledKeys = new Set<string>();
  const snoozedKeys = new Set<string>();
  let visibleThreadCount = 0;

  const rowsOf = (folderId: string): SidebarFolderThreadRow<TThread>[] =>
    (layout.threadKeysByFolderId[folderId] ?? []).flatMap((key) => {
      const thread = threadByKey.get(key);
      if (thread === undefined) return [];
      const section = input.sectionOf(thread);
      if (section === "settled") settledKeys.add(key);
      else if (section === "snoozed") snoozedKeys.add(key);
      visibleThreadCount += 1;
      return [{ thread, key, section }];
    });

  const build = (
    folder: SidebarFolder,
    depth: number,
  ): { node: SidebarFolderTreeNode<TThread>; rendered: TThread[] } | null => {
    const built = layout.folders
      .filter((candidate) => candidate.parentId === folder.id)
      .flatMap((child) => {
        const result = build(child, depth + 1);
        return result === null ? [] : [result];
      });
    const ownRows = rowsOf(folder.id);
    const subtreeThreads = [
      ...built.flatMap(({ node }) => node.subtreeThreads),
      ...ownRows.map((row) => row.thread),
    ];
    if (input.hideEmptyFolders && subtreeThreads.length === 0) return null;
    const isCollapsed = collapsed.has(folder.id);
    return {
      node: {
        folder,
        depth,
        collapsed: isCollapsed,
        children: isCollapsed ? [] : built.map(({ node }) => node),
        rows: isCollapsed ? [] : ownRows,
        subtreeThreads,
      },
      rendered: isCollapsed
        ? []
        : [...built.flatMap(({ rendered }) => rendered), ...ownRows.map((row) => row.thread)],
    };
  };
  const roots = layout.folders
    .filter((folder) => folder.parentId === null)
    .flatMap((folder) => {
      const result = build(folder, 0);
      if (result === null) return [];
      renderedThreads.push(...result.rendered);
      return [result.node];
    });
  return { roots, renderedThreads, settledKeys, snoozedKeys, visibleThreadCount };
}
