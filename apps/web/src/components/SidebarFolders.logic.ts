import type { OrganizingIconOverride } from "@t3tools/contracts";
import { sidebarMarkerId, type SidebarListItem, type SidebarSection } from "./Sidebar.logic";

/** A user folder in the sidebar. Sibling order is the order in `folders`. */
export interface SidebarFolder {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly icon?: OrganizingIconOverride | null;
  /** Logical project key new chats start in. Unset inherits the parent's. */
  readonly defaultProjectKey?: string | null | undefined;
}

/** Client-local folder layout. Thread keys are scoped thread keys, so one
    layout can hold threads from every environment. */
export interface SidebarFolderLayout {
  readonly folders: readonly SidebarFolder[];
  /** Ordered thread keys per folder. A thread lives in at most one folder. */
  readonly threadKeysByFolderId: Readonly<Record<string, readonly string[]>>;
  /** Explicit user destinations. Null keeps a chat in the main list instead
      of letting ticket, task, or fork routing file it again. */
  readonly threadFolderOverrides?: Readonly<Record<string, string | null>>;
  readonly collapsedFolderIds: readonly string[];
  /** Absent in older saved layouts; settled shelves start collapsed. */
  readonly expandedSettledFolderIds?: readonly string[] | undefined;
  /** Folders the user settled. Nested folders use their parent's shelf. */
  readonly settledFolderIds?: readonly string[] | undefined;
}

export const EMPTY_SIDEBAR_FOLDER_LAYOUT: SidebarFolderLayout = {
  folders: [],
  threadKeysByFolderId: {},
  threadFolderOverrides: {},
  collapsedFolderIds: [],
  expandedSettledFolderIds: [],
  settledFolderIds: [],
};

export function folderIdByThreadKey(layout: SidebarFolderLayout): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const [folderId, threadKeys] of Object.entries(layout.threadKeysByFolderId)) {
    for (const threadKey of threadKeys) mapping.set(threadKey, folderId);
  }
  return mapping;
}

/** Whether the user has explicitly chosen this chat's folder destination. */
export function hasSidebarThreadFolderOverride(
  layout: SidebarFolderLayout,
  threadKey: string,
): boolean {
  return Object.hasOwn(layout.threadFolderOverrides ?? {}, threadKey);
}

/**
 * Chats filed in open folders, whose ancestors are all open too, that the shell leaves out.
 * Only shell rows decide: a read adds its rows to the thread list, so deciding from that list
 * would release the read again and loop.
 */
export function openFolderThreadKeys(
  layout: SidebarFolderLayout,
  shellThreadKeys: ReadonlySet<string>,
): string[] {
  const collapsed = new Set(layout.collapsedFolderIds);
  const byId = new Map(layout.folders.map((folder) => [folder.id, folder]));
  const isOpen = (folderId: string): boolean => {
    const seen = new Set<string>();
    let folder = byId.get(folderId);
    while (folder !== undefined && !seen.has(folder.id)) {
      if (collapsed.has(folder.id)) return false;
      seen.add(folder.id);
      folder = folder.parentId === null ? undefined : byId.get(folder.parentId);
    }
    return true;
  };
  const keys = new Set<string>();
  for (const folder of layout.folders) {
    if (!isOpen(folder.id)) continue;
    for (const key of layout.threadKeysByFolderId[folder.id] ?? []) {
      if (!shellThreadKeys.has(key)) keys.add(key);
    }
  }
  return [...keys];
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

/** Includes descendant folders, so folder actions cover the whole feature. */
export function folderSubtreeThreadKeys(layout: SidebarFolderLayout, folderId: string): string[] {
  const subtree = folderSubtreeIds(layout, folderId);
  return [...new Set([...subtree].flatMap((id) => layout.threadKeysByFolderId[id] ?? []))];
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
  // `/` separates folders in ticket and task folder paths.
  if (trimmed.length === 0 || trimmed.includes("/")) return layout;
  return {
    ...layout,
    folders: layout.folders.map((folder) =>
      folder.id === folderId ? { ...folder, name: trimmed } : folder,
    ),
  };
}

export function setSidebarFolderIcon(
  layout: SidebarFolderLayout,
  folderId: string,
  icon: OrganizingIconOverride | null,
): SidebarFolderLayout {
  return {
    ...layout,
    folders: layout.folders.map((folder) =>
      folder.id === folderId ? { ...folder, icon } : folder,
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
    ...layout,
    folders: layout.folders.filter((folder) => !removed.has(folder.id)),
    threadKeysByFolderId: Object.fromEntries(
      Object.entries(layout.threadKeysByFolderId).filter(([id]) => !removed.has(id)),
    ),
    threadFolderOverrides: Object.fromEntries(
      Object.entries(layout.threadFolderOverrides ?? {}).map(([threadKey, targetFolderId]) => [
        threadKey,
        targetFolderId !== null && removed.has(targetFolderId) ? null : targetFolderId,
      ]),
    ),
    collapsedFolderIds: layout.collapsedFolderIds.filter((id) => !removed.has(id)),
    expandedSettledFolderIds: (layout.expandedSettledFolderIds ?? []).filter(
      (id) => !removed.has(id),
    ),
    settledFolderIds: (layout.settledFolderIds ?? []).filter((id) => !removed.has(id)),
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

export function toggleSidebarFolderSettledExpanded(
  layout: SidebarFolderLayout,
  folderId: string,
): SidebarFolderLayout {
  const expanded = layout.expandedSettledFolderIds ?? [];
  return {
    ...layout,
    expandedSettledFolderIds: expanded.includes(folderId)
      ? expanded.filter((id) => id !== folderId)
      : [...expanded, folderId],
  };
}

/** Settling is a folder's own choice: it never follows from its chats being settled. */
export function setSidebarFolderSettled(
  layout: SidebarFolderLayout,
  folderId: string,
  settled: boolean,
): SidebarFolderLayout {
  const folder = layout.folders.find((candidate) => candidate.id === folderId);
  if (folder === undefined) return layout;
  const rest = (layout.settledFolderIds ?? []).filter((id) => id !== folderId);
  return { ...layout, settledFolderIds: settled ? [...rest, folderId] : rest };
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

/** Moves a chat at the user's request and remembers that choice so automatic
    ticket, task, and fork routing cannot later undo it. */
export function moveThreadToSidebarFolderManually(
  layout: SidebarFolderLayout,
  threadKey: string,
  target: SidebarThreadFolderTarget | null,
): SidebarFolderLayout {
  if (target !== null && !layout.folders.some((folder) => folder.id === target.folderId)) {
    return layout;
  }
  return {
    ...moveThreadToSidebarFolder(layout, threadKey, target),
    threadFolderOverrides: {
      ...layout.threadFolderOverrides,
      [threadKey]: target?.folderId ?? null,
    },
  };
}

/**
 * Files each new fork right after its source thread when the source sits in a
 * folder. Forks that are already filed (by a ticket route, say) stay put.
 */
export function fileForksWithSources(
  layout: SidebarFolderLayout,
  forks: readonly { readonly threadKey: string; readonly sourceThreadKey: string }[],
): SidebarFolderLayout {
  let next = layout;
  for (const fork of forks) {
    if (hasSidebarThreadFolderOverride(next, fork.threadKey)) continue;
    const folderByThread = folderIdByThreadKey(next);
    const folderId = folderByThread.get(fork.sourceThreadKey);
    if (folderId === undefined || folderByThread.has(fork.threadKey)) continue;
    next = moveThreadToSidebarFolder(next, fork.threadKey, {
      folderId,
      position: "after",
      threadKey: fork.sourceThreadKey,
    });
  }
  return next;
}

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
  /** Subfolders visible behind this folder's Settled shelf. */
  readonly settledChildren: ReadonlyArray<SidebarFolderTreeNode<TThread>>;
  /** This folder's threads in visual order, with settled rows last; empty while collapsed. */
  readonly rows: ReadonlyArray<SidebarFolderThreadRow<TThread>>;
  /** Chats and folders behind this folder's own Settled shelf. Zero inside the Settled
      section, where a folder's rows render directly. */
  readonly settledCount: number;
  readonly settledExpanded: boolean;
  /** Visible threads in this folder and below, for the header rollup. */
  readonly subtreeThreads: readonly TThread[];
}

export interface SidebarFolderTree<TThread> {
  readonly roots: ReadonlyArray<SidebarFolderTreeNode<TThread>>;
  /** Top-level folders the user settled. They render in the main Settled
      section, and return to `roots` while any of their threads is active. */
  readonly settledRoots: ReadonlyArray<SidebarFolderTreeNode<TThread>>;
  /** Rendered thread rows of `roots` in visual order, for traversal and jump hints. */
  readonly renderedThreads: readonly TThread[];
  readonly settledKeys: ReadonlySet<string>;
  readonly snoozedKeys: ReadonlySet<string>;
  readonly visibleThreadCount: number;
}

/** Rendered thread rows under these folders, in visual order. */
export function renderedSidebarFolderThreads<TThread>(
  nodes: ReadonlyArray<SidebarFolderTreeNode<TThread>>,
): TThread[] {
  return nodes.flatMap((node) => {
    const firstSettledIndex = node.rows.findIndex((row) => row.section === "settled");
    const settledStart = firstSettledIndex === -1 ? node.rows.length : firstSettledIndex;
    return [
      ...renderedSidebarFolderThreads(node.children),
      ...node.rows.slice(0, settledStart).map((row) => row.thread),
      ...renderedSidebarFolderThreads(node.settledChildren),
      ...node.rows.slice(settledStart).map((row) => row.thread),
    ];
  });
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
  /** The open thread remains visible under a collapsed shelf, like the main list. */
  readonly routeThreadKey?: string | null;
}): SidebarFolderTree<TThread> {
  const { layout, threadByKey } = input;
  const collapsed = new Set(layout.collapsedFolderIds);
  const expandedSettled = new Set(layout.expandedSettledFolderIds);
  const settledFolderIds = new Set(layout.settledFolderIds);
  const settledKeys = new Set<string>();
  const snoozedKeys = new Set<string>();
  let visibleThreadCount = 0;

  const rowsOf = (folderId: string): SidebarFolderThreadRow<TThread>[] => {
    const rows: SidebarFolderThreadRow<TThread>[] = [];
    const settledRows: SidebarFolderThreadRow<TThread>[] = [];
    for (const key of layout.threadKeysByFolderId[folderId] ?? []) {
      const thread = threadByKey.get(key);
      if (thread === undefined) continue;
      const section = input.sectionOf(thread);
      if (section === "settled") settledKeys.add(key);
      else if (section === "snoozed") snoozedKeys.add(key);
      visibleThreadCount += 1;
      (section === "settled" ? settledRows : rows).push({ thread, key, section });
    }
    return [...rows, ...settledRows];
  };
  const ownRowsByFolderId = new Map(layout.folders.map((folder) => [folder.id, rowsOf(folder.id)]));
  const childrenByParentId = new Map<string | null, SidebarFolder[]>();
  for (const folder of layout.folders) {
    const siblings = childrenByParentId.get(folder.parentId) ?? [];
    siblings.push(folder);
    childrenByParentId.set(folder.parentId, siblings);
  }
  const activeByFolderId = new Map<string, boolean>();
  const hasActiveThread = (folderId: string): boolean => {
    const cached = activeByFolderId.get(folderId);
    if (cached !== undefined) return cached;
    const active =
      (ownRowsByFolderId.get(folderId) ?? []).some((row) => row.section === "active") ||
      (childrenByParentId.get(folderId) ?? []).some((child) => hasActiveThread(child.id));
    activeByFolderId.set(folderId, active);
    return active;
  };
  // An active thread keeps a settled folder in view, so live work never hides.
  const isSettledFolder = (folderId: string): boolean =>
    settledFolderIds.has(folderId) && !hasActiveThread(folderId);

  // Keep the open chat's folder visible through collapsed settled shelves.
  const routeFolderIds = new Set<string>();
  const folderById = new Map(layout.folders.map((folder) => [folder.id, folder]));
  let routeFolderId = input.routeThreadKey
    ? folderIdByThreadKey(layout).get(input.routeThreadKey)
    : undefined;
  while (routeFolderId !== undefined && !routeFolderIds.has(routeFolderId)) {
    routeFolderIds.add(routeFolderId);
    routeFolderId = folderById.get(routeFolderId)?.parentId ?? undefined;
  }

  const build = (
    folder: SidebarFolder,
    depth: number,
    inSettledSection: boolean,
  ): SidebarFolderTreeNode<TThread> | null => {
    const children = (childrenByParentId.get(folder.id) ?? []).flatMap(
      (child) => build(child, depth + 1, inSettledSection || isSettledFolder(child.id)) ?? [],
    );
    const activeChildren = inSettledSection
      ? children
      : children.filter((child) => !isSettledFolder(child.folder.id));
    const settledChildren = inSettledSection
      ? []
      : children.filter((child) => isSettledFolder(child.folder.id));
    const ownRows = ownRowsByFolderId.get(folder.id) ?? [];
    const subtreeThreads = [
      ...children.flatMap((node) => node.subtreeThreads),
      ...ownRows.map((row) => row.thread),
    ];
    if (input.hideEmptyFolders && subtreeThreads.length === 0) return null;
    const isCollapsed = collapsed.has(folder.id);
    const settledExpanded = expandedSettled.has(folder.id);
    const rows = isCollapsed
      ? []
      : inSettledSection
        ? ownRows
        : ownRows.filter(
            (row) =>
              row.section !== "settled" || settledExpanded || row.key === input.routeThreadKey,
          );
    return {
      folder,
      depth,
      collapsed: isCollapsed,
      children: isCollapsed ? [] : activeChildren,
      settledChildren: isCollapsed
        ? []
        : settledChildren.filter((child) => settledExpanded || routeFolderIds.has(child.folder.id)),
      rows,
      settledCount: inSettledSection
        ? 0
        : ownRows.filter((row) => row.section === "settled").length + settledChildren.length,
      settledExpanded,
      subtreeThreads,
    };
  };
  const roots: SidebarFolderTreeNode<TThread>[] = [];
  const settledRoots: SidebarFolderTreeNode<TThread>[] = [];
  for (const folder of layout.folders) {
    if (folder.parentId !== null) continue;
    const settled = isSettledFolder(folder.id);
    const node = build(folder, 0, settled);
    if (node !== null) (settled ? settledRoots : roots).push(node);
  }
  return {
    roots,
    settledRoots,
    renderedThreads: renderedSidebarFolderThreads(roots),
    settledKeys,
    snoozedKeys,
    visibleThreadCount,
  };
}
