import {
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Over,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { ContextMenuItem, LocalApi, ScopedProjectRef, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  MoreHorizontalIcon,
  SquarePenIcon,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import { openCommandPalette } from "../commandPaletteBus";
import { readLocalApi } from "../localApi";
import { useSidebarFolderStore, useSidebarFolderUiStore } from "../sidebarFolderStore";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../types";
import { useUiStateStore } from "../uiStateStore";
import {
  resolveProjectStatusIndicator,
  resolveThreadStatusPill,
  type SidebarDropVerb,
  type SidebarListItem,
  type SidebarSection,
} from "./Sidebar.logic";
import {
  buildSidebarFolderTree,
  filedSidebarThreadKeys,
  flattenSidebarFolders,
  folderDndId,
  folderIdByThreadKey,
  folderThreadDndId,
  parseSidebarFolderDndId,
  planSidebarFolderDrop,
  resolveSidebarFolderDefaultProject,
  resolveSidebarFolderDropSlot,
  SIDEBAR_FOLDER_ROOT_DND_ID,
  sidebarSectionForListItemId,
  type SidebarFolderDragSource,
  type SidebarFolderDropPlan,
  type SidebarFolderLayout,
  type SidebarFolderThreadSection,
  type SidebarFolderTree,
  type SidebarFolderTreeNode,
} from "./SidebarFolders.logic";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// ---------------------------------------------------------------------------
// Layout

export function useSidebarFolderLayout(): SidebarFolderLayout {
  const folders = useSidebarFolderStore((state) => state.folders);
  const threadKeysByFolderId = useSidebarFolderStore((state) => state.threadKeysByFolderId);
  const collapsedFolderIds = useSidebarFolderStore((state) => state.collapsedFolderIds);
  return useMemo(
    () => ({ folders, threadKeysByFolderId, collapsedFolderIds }),
    [collapsedFolderIds, folders, threadKeysByFolderId],
  );
}

const threadKeyOf = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/** Keys the main list must skip because their rows render in a folder. */
export function useFiledSidebarThreadKeys(
  layout: SidebarFolderLayout,
  threads: readonly EnvironmentThreadShell[],
): ReadonlySet<string> {
  return useMemo(() => filedSidebarThreadKeys(layout, threads, threadKeyOf), [layout, threads]);
}

type ThreadCapabilities = { readonly threadSettlement?: boolean; readonly threadSnooze?: boolean };

export function useSidebarFolderTree(input: {
  layout: SidebarFolderLayout;
  threads: readonly EnvironmentThreadShell[];
  filedThreadKeys: ReadonlySet<string>;
  scopedProjectKeys: ReadonlySet<string> | null;
  capabilitiesOf: (thread: EnvironmentThreadShell) => ThreadCapabilities | undefined;
  /** Precise clock from the main list's partition, so both agree on snoozes. */
  now: string;
}): SidebarFolderTree<EnvironmentThreadShell> & {
  readonly sectionByKey: ReadonlyMap<string, SidebarFolderThreadSection>;
  /** Every visible filed thread, rendered or not, for search. */
  readonly visibleThreads: readonly EnvironmentThreadShell[];
} {
  const { layout, threads, filedThreadKeys, scopedProjectKeys, capabilitiesOf, now } = input;
  return useMemo(() => {
    const threadByKey = new Map<string, EnvironmentThreadShell>();
    for (const thread of threads) {
      const key = threadKeyOf(thread);
      if (!filedThreadKeys.has(key) || thread.archivedAt !== null) continue;
      if (
        scopedProjectKeys !== null &&
        !scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)
      ) {
        continue;
      }
      threadByKey.set(key, thread);
    }
    // Same classification as the main list: snooze outranks settlement,
    // and both need the server capability.
    const sectionByKey = new Map<string, SidebarFolderThreadSection>();
    const tree = buildSidebarFolderTree({
      layout,
      threadByKey,
      sectionOf: (thread) => {
        const capabilities = capabilitiesOf(thread);
        const section: SidebarFolderThreadSection =
          capabilities?.threadSnooze === true && effectiveSnoozed(thread, { now })
            ? "snoozed"
            : capabilities?.threadSettlement === true && thread.settledOverride === "settled"
              ? "settled"
              : "active";
        sectionByKey.set(threadKeyOf(thread), section);
        return section;
      },
      hideEmptyFolders: scopedProjectKeys !== null,
    });
    return { ...tree, sectionByKey, visibleThreads: [...threadByKey.values()] };
  }, [capabilitiesOf, filedThreadKeys, layout, now, scopedProjectKeys, threads]);
}

// ---------------------------------------------------------------------------
// Drag and drop

type DragBag = {
  listeners: ReturnType<typeof useDraggable>["listeners"];
  setNodeRef: (node: HTMLElement | null) => void;
  transform: ReturnType<typeof useDraggable>["transform"];
  transition: string | undefined;
  isDragging: boolean;
};

/** Main-list drop outcome for a filed thread, shown as the lifted row's badge. */
function leaveFolderDropVerb(
  from: SidebarFolderThreadSection,
  to: SidebarSection,
): SidebarDropVerb | null {
  if (to === "pinned") return "pin";
  if (to === "settled") return from === "settled" ? null : "settle";
  if (to === "active") return from === "settled" ? "unsettle" : from === "snoozed" ? "wake" : null;
  return null;
}

/**
 * Folder drags share the sidebar's DndContext so threads can move between
 * folders and the main list. This wraps the list's own handlers: anything
 * that starts or lands on a folder row is handled here; everything else
 * passes through untouched.
 */
export function useSidebarFolderDnd(input: {
  collisionDetection: CollisionDetection;
  onDragStart: (event: DragStartEvent) => void;
  onDragOver: (event: DragOverEvent) => void;
  onDragEnd: (event: DragEndEvent) => void;
  sidebarListItems: readonly SidebarListItem[];
  blockRef: MutableRefObject<HTMLElement | null>;
  listRef: MutableRefObject<HTMLElement | null>;
  /** The list's pickup clamp; folder drags lift it so rows can reach folders. */
  dragLabelOffsetRef: MutableRefObject<number>;
  hasFolders: boolean;
  /** Filed threads that are rendered, with their lifecycle section. */
  filedSectionByKey: ReadonlyMap<string, SidebarFolderThreadSection>;
  /** A main-list thread was dropped into a folder. */
  onThreadFiled: (threadKey: string) => void;
  /** A filed thread was dropped onto the main list. */
  onThreadUnfiled: (threadKey: string, section: SidebarSection) => void;
}) {
  const pointerYRef = useRef<number | null>(null);
  const sourceRef = useRef<SidebarFolderDragSource | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;

  const theirCollisionDetection = input.collisionDetection;
  const collisionDetection = useMemo<CollisionDetection>(
    () => (args) => {
      pointerYRef.current = args.pointerCoordinates?.y ?? null;
      const ours = args.droppableContainers.filter(
        (container) => parseSidebarFolderDndId(String(container.id)) !== null,
      );
      const theirs = args.droppableContainers.filter(
        (container) => parseSidebarFolderDndId(String(container.id)) === null,
      );
      const source = sourceRef.current;
      const pointer = args.pointerCoordinates;
      const block = inputRef.current.blockRef.current?.getBoundingClientRect();
      const inBlock =
        pointer !== null &&
        block !== undefined &&
        pointer.y >= block.top &&
        pointer.y <= block.bottom;
      if (inBlock) {
        const hits = pointerWithin({ ...args, droppableContainers: ours });
        if (hits.length > 0) return hits;
        // Gaps between folder rows keep folder drags inside the block and
        // leave main-list drags without a target rather than guessing.
        return source === null ? [] : closestCenter({ ...args, droppableContainers: ours });
      }
      if (source === null) return theirCollisionDetection({ ...args, droppableContainers: theirs });
      // Folders stay in the folder block; filed threads may leave it.
      if (source.kind === "folder") return [];
      return closestCenter({ ...args, droppableContainers: theirs });
    },
    [theirCollisionDetection],
  );

  const resolvePlan = useCallback(
    (over: Over | null, source: SidebarFolderDragSource): SidebarFolderDropPlan | null => {
      if (over === null) return null;
      const item = parseSidebarFolderDndId(String(over.id));
      if (item === null) return null;
      const slot = resolveSidebarFolderDropSlot({
        over: item,
        source,
        pointerY: pointerYRef.current,
        rect: over.rect,
      });
      const layout = useSidebarFolderStore.getState();
      const plan = planSidebarFolderDrop({ layout, source, slot });
      return plan.kind === "none" ? null : plan;
    },
    [],
  );

  const updateIndicator = useCallback(
    (over: Over | null, activeId: string) => {
      const ui = useSidebarFolderUiStore.getState();
      const source =
        sourceRef.current ?? ({ kind: "thread", threadKey: activeId } as SidebarFolderDragSource);
      const plan = resolvePlan(over, source);
      if (plan === null || over === null) {
        ui.setDropSlot(null);
      } else {
        const item = parseSidebarFolderDndId(String(over.id))!;
        ui.setDropSlot(
          resolveSidebarFolderDropSlot({
            over: item,
            source,
            pointerY: pointerYRef.current,
            rect: over.rect,
          }),
        );
      }
      if (sourceRef.current?.kind === "thread" && over !== null && plan === null) {
        const section = sidebarSectionForListItemId(
          inputRef.current.sidebarListItems,
          String(over.id),
        );
        const from = inputRef.current.filedSectionByKey.get(sourceRef.current.threadKey);
        ui.setLeaveDropVerb(
          section === null || from === undefined ? null : leaveFolderDropVerb(from, section),
        );
      } else {
        ui.setLeaveDropVerb(null);
      }
    },
    [resolvePlan],
  );

  const reset = useCallback(() => {
    sourceRef.current = null;
    pointerYRef.current = null;
    const ui = useSidebarFolderUiStore.getState();
    ui.setDropSlot(null);
    ui.setDragKind(null);
    ui.setLeaveDropVerb(null);
  }, []);

  const onDragStart = useCallback((event: DragStartEvent) => {
    const item = parseSidebarFolderDndId(String(event.active.id));
    const ui = useSidebarFolderUiStore.getState();
    if (item !== null && item.kind !== "root") {
      sourceRef.current =
        item.kind === "folder"
          ? { kind: "folder", folderId: item.folderId }
          : { kind: "thread", threadKey: item.threadKey };
      ui.setDragKind(item.kind);
      inputRef.current.dragLabelOffsetRef.current = Number.NEGATIVE_INFINITY;
      return;
    }
    inputRef.current.onDragStart(event);
    if (!inputRef.current.hasFolders) return;
    ui.setDragKind("thread");
    // Let main-list rows travel up past the Pinned label into the folders.
    const list = inputRef.current.listRef.current;
    const block = inputRef.current.blockRef.current;
    if (list && block) {
      inputRef.current.dragLabelOffsetRef.current =
        block.getBoundingClientRect().top - list.getBoundingClientRect().top;
    }
  }, []);

  const onDragMove = useCallback(
    (event: DragMoveEvent) => updateIndicator(event.over, String(event.active.id)),
    [updateIndicator],
  );

  const onDragOver = useCallback(
    (event: DragOverEvent) => {
      if (sourceRef.current === null) inputRef.current.onDragOver(event);
      updateIndicator(event.over, String(event.active.id));
    },
    [updateIndicator],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const source = sourceRef.current;
      const activeId = String(event.active.id);
      const overId = event.over === null ? null : String(event.over.id);
      const plan = resolvePlan(event.over, source ?? { kind: "thread", threadKey: activeId });
      reset();
      const store = useSidebarFolderStore.getState();
      if (plan !== null) {
        if (plan.kind === "move-folder") store.moveFolder(plan.folderId, plan.target);
        if (plan.kind === "file-thread") {
          if (source === null) inputRef.current.onThreadFiled(plan.threadKey);
          store.moveThread(plan.threadKey, plan.target);
        }
        return;
      }
      if (source === null) {
        // A main-list drag that did not land on a folder row.
        if (overId === null || parseSidebarFolderDndId(overId) === null) {
          inputRef.current.onDragEnd(event);
        }
        return;
      }
      if (source.kind !== "thread" || overId === null) return;
      const section = sidebarSectionForListItemId(inputRef.current.sidebarListItems, overId);
      if (section === null) return;
      store.moveThread(source.threadKey, null);
      inputRef.current.onThreadUnfiled(source.threadKey, section);
    },
    [reset, resolvePlan],
  );

  const onDragCancel = useCallback((_event: DragCancelEvent) => reset(), [reset]);

  return { collisionDetection, onDragStart, onDragMove, onDragOver, onDragEnd, onDragCancel };
}

// ---------------------------------------------------------------------------
// Context menus

export type SidebarFolderMenuId =
  | "folder-move"
  | `folder-move:${string}`
  | "folder-new"
  | "folder-remove";

/** Adds "Move to folder" beside the thread's lifecycle actions. */
export function withSidebarFolderMenuItems<T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
  input: { layout: SidebarFolderLayout; threadKey: string },
): Array<ContextMenuItem<T | SidebarFolderMenuId>> {
  const currentFolderId = folderIdByThreadKey(input.layout).get(input.threadKey) ?? null;
  const folders = flattenSidebarFolders(input.layout);
  const folderItem: ContextMenuItem<SidebarFolderMenuId> = {
    id: "folder-move",
    label: "Move to folder",
    icon: "folder",
    children: [
      ...folders.map(({ folder, path }) => ({
        id: `folder-move:${folder.id}` as const,
        label: path,
        checked: folder.id === currentFolderId,
      })),
      { id: "folder-new", label: "New folder…", separatorBefore: folders.length > 0 },
      ...(currentFolderId === null
        ? []
        : [{ id: "folder-remove" as const, label: "Remove from folder" }]),
    ],
  };
  const insertAt = items.findIndex((item) => item.id === "rename");
  const at = insertAt === -1 ? items.length : insertAt;
  return [...items.slice(0, at), folderItem, ...items.slice(at)];
}

/** Shows a thread's action menu with the folder items added. */
export function showThreadMenuWithFolders<T extends string>(
  api: LocalApi,
  items: ReadonlyArray<ContextMenuItem<T>>,
  position: { x: number; y: number },
  threadKey: string,
) {
  return api.contextMenu.show(
    withSidebarFolderMenuItems(items, { layout: useSidebarFolderStore.getState(), threadKey }),
    position,
  );
}

/** Applies a thread-menu folder pick. Returns false for other menu ids. */
export function applySidebarFolderMenuSelection(
  value: string,
  threadKey: string,
  onThreadFiled: (threadKey: string) => void,
): boolean {
  const store = useSidebarFolderStore.getState();
  if (value === "folder-remove") {
    store.moveThread(threadKey, null);
    return true;
  }
  if (value === "folder-new") {
    const folderId = store.createFolder({ name: "New folder", parentId: null });
    onThreadFiled(threadKey);
    store.moveThread(threadKey, { folderId, position: "start" });
    useSidebarFolderUiStore.getState().setRenamingFolderId(folderId);
    return true;
  }
  if (value.startsWith("folder-move:")) {
    onThreadFiled(threadKey);
    store.moveThread(threadKey, {
      folderId: value.slice("folder-move:".length),
      position: "start",
    });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// New chats

export interface SidebarFolderChatActions {
  /** Sidebar projects, for resolving a folder's default project key. */
  readonly projects: readonly SidebarProjectSnapshot[];
  /** Starts a chat in a project and files it into the folder. */
  readonly startChat: (folderId: string, projectRef: ScopedProjectRef) => void;
  /** Opens the command palette's project picker for a new chat or the
      folder's default project. */
  readonly pickProject: (folderId: string, purpose: "chat" | "default") => void;
}

/**
 * The draft's thread id is minted up front, so the folder can claim the key
 * immediately; the row appears in the folder once the first message creates
 * the server thread.
 */
export function useSidebarFolderChatActions(input: {
  projects: readonly SidebarProjectSnapshot[];
  handleNewThread: (
    projectRef: ScopedProjectRef,
  ) => Promise<{ readonly threadId: ThreadId } | null>;
  /** Runs before navigating or opening the palette, e.g. to close the mobile sidebar. */
  beforeNavigate: () => void;
}): SidebarFolderChatActions {
  const inputRef = useRef(input);
  inputRef.current = input;
  const startChat = useCallback((folderId: string, projectRef: ScopedProjectRef) => {
    inputRef.current.beforeNavigate();
    void (async () => {
      const result = await inputRef.current.handleNewThread(projectRef);
      if (result === null) return;
      useSidebarFolderStore
        .getState()
        .moveThread(scopedThreadKey(scopeThreadRef(projectRef.environmentId, result.threadId)), {
          folderId,
          position: "start",
        });
    })();
  }, []);
  const pickProject = useCallback(
    (folderId: string, purpose: "chat" | "default") => {
      inputRef.current.beforeNavigate();
      openCommandPalette({
        open: "new-thread-in",
        onPickProject: (projectRef) => {
          if (purpose === "chat") {
            startChat(folderId, projectRef);
            return;
          }
          const project = inputRef.current.projects.find((candidate) =>
            candidate.memberProjectRefs.some(
              (member) =>
                member.environmentId === projectRef.environmentId &&
                member.projectId === projectRef.projectId,
            ),
          );
          if (project) {
            useSidebarFolderStore.getState().setFolderDefaultProject(folderId, project.projectKey);
          }
        },
      });
    },
    [startChat],
  );
  const { projects } = input;
  return useMemo(() => ({ projects, startChat, pickProject }), [pickProject, projects, startChat]);
}

async function showFolderMenu(
  folderId: string,
  position: { x: number; y: number },
  actions: SidebarFolderChatActions,
) {
  const api = readLocalApi();
  if (!api) return;
  const layout = useSidebarFolderStore.getState();
  const ownDefaultKey =
    layout.folders.find((candidate) => candidate.id === folderId)?.defaultProjectKey ?? null;
  const ownDefault =
    ownDefaultKey === null
      ? null
      : (actions.projects.find((project) => project.projectKey === ownDefaultKey) ?? null);
  const clicked = await settlePromise(() =>
    api.contextMenu.show(
      [
        {
          id: "new-chat",
          label: "New chat in…",
          icon: "message-square-plus",
          disabled: actions.projects.length === 0,
        },
        {
          id: "default-project",
          label: ownDefaultKey === null ? "Set default project…" : "Change default project…",
          icon: "folder-tree",
          disabled: actions.projects.length === 0,
        },
        ...(ownDefaultKey === null
          ? []
          : [
              {
                id: "clear-default-project",
                label: ownDefault
                  ? `Clear default project (${ownDefault.displayName})`
                  : "Clear default project",
              },
            ]),
        { id: "new-subfolder", label: "New subfolder", icon: "folder", separatorBefore: true },
        { id: "rename", label: "Rename folder", icon: "pencil" },
        {
          id: "delete",
          label: "Delete folder",
          icon: "trash",
          destructive: true,
          separatorBefore: true,
        },
      ],
      position,
    ),
  );
  if (clicked._tag === "Failure" || clicked.value === null) return;
  const store = useSidebarFolderStore.getState();
  const ui = useSidebarFolderUiStore.getState();
  switch (clicked.value) {
    case "new-chat":
      actions.pickProject(folderId, "chat");
      return;
    case "default-project":
      actions.pickProject(folderId, "default");
      return;
    case "clear-default-project":
      store.setFolderDefaultProject(folderId, null);
      return;
    case "new-subfolder":
      ui.setRenamingFolderId(store.createFolder({ name: "New folder", parentId: folderId }));
      return;
    case "rename":
      ui.setRenamingFolderId(folderId);
      return;
    case "delete": {
      const folder = store.folders.find((candidate) => candidate.id === folderId);
      if (!folder) return;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            `Delete folder "${folder.name}"?`,
            "Its subfolders are deleted too. Threads move back to the main list.",
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Success" && confirmed.value) store.deleteFolder(folderId);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering

export type RenderSidebarFolderThreadRow<TThread> = (
  thread: TThread,
  section: SidebarFolderThreadSection,
  bag: DragBag,
  dropVerb: SidebarDropVerb | null,
) => ReactNode;

// Deeper folders keep working but stop indenting: the sidebar is narrow.
const MAX_INDENTED_DEPTH = 4;

// Zero-height, so showing the insertion line never shifts the rows.
function DropLine() {
  return (
    <li aria-hidden className="pointer-events-none relative h-0 list-none">
      <div className="absolute inset-x-1 -top-px z-30 h-0.5 rounded-full bg-primary" />
    </li>
  );
}

function FolderRenameInput(props: { folderId: string; name: string }) {
  const [value, setValue] = useState(props.name);
  const committedRef = useRef(false);
  const commit = (save: boolean) => {
    if (committedRef.current) return;
    committedRef.current = true;
    if (save) useSidebarFolderStore.getState().renameFolder(props.folderId, value);
    useSidebarFolderUiStore.getState().setRenamingFolderId(null);
  };
  return (
    <input
      autoFocus
      aria-label="Folder name"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.target.select()}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") commit(true);
        if (event.key === "Escape") commit(false);
      }}
      onBlur={() => commit(true)}
      className="min-w-0 flex-1 rounded-sm border border-sidebar-border bg-sidebar px-1 text-sm text-sidebar-foreground outline-none focus:border-primary/60"
    />
  );
}

function FolderThreadRow<TThread>(props: {
  row: { thread: TThread; key: string; section: SidebarFolderThreadSection };
  disabled: boolean;
  renderThreadRow: RenderSidebarFolderThreadRow<TThread>;
}) {
  const id = folderThreadDndId(props.row.key);
  const draggable = useDraggable({ id, disabled: props.disabled });
  const droppable = useDroppable({ id });
  const zone = useSidebarFolderUiStore((state) =>
    state.dropSlot?.kind === "thread" && state.dropSlot.threadKey === props.row.key
      ? state.dropSlot.zone
      : null,
  );
  const leaveDropVerb = useSidebarFolderUiStore((state) =>
    draggable.isDragging ? state.leaveDropVerb : null,
  );
  const { setNodeRef: setDragRef } = draggable;
  const { setNodeRef: setDropRef } = droppable;
  const setNodeRef = useCallback(
    (node: HTMLElement | null) => {
      setDragRef(node);
      setDropRef(node);
    },
    [setDragRef, setDropRef],
  );
  const bag = useMemo<DragBag>(
    () => ({
      listeners: draggable.listeners,
      setNodeRef,
      transform: draggable.transform,
      transition: undefined,
      isDragging: draggable.isDragging,
    }),
    [draggable.isDragging, draggable.listeners, draggable.transform, setNodeRef],
  );
  return (
    <>
      {zone === "before" ? <DropLine /> : null}
      {props.renderThreadRow(props.row.thread, props.row.section, bag, leaveDropVerb)}
      {zone === "after" ? <DropLine /> : null}
    </>
  );
}

function FolderNode<TThread extends SidebarThreadSummary>(props: {
  node: SidebarFolderTreeNode<TThread>;
  renamingThreadKey: string | null;
  renderThreadRow: RenderSidebarFolderThreadRow<TThread>;
  chatActions: SidebarFolderChatActions;
}) {
  const { node } = props;
  const { folder } = node;
  const id = folderDndId(folder.id);
  const isRenaming = useSidebarFolderUiStore((state) => state.renamingFolderId === folder.id);
  const zone = useSidebarFolderUiStore((state) =>
    state.dropSlot?.kind === "folder" && state.dropSlot.folderId === folder.id
      ? state.dropSlot.zone
      : null,
  );
  const draggable = useDraggable({ id, disabled: isRenaming });
  const droppable = useDroppable({ id });
  const toggleFolderCollapsed = useSidebarFolderStore((state) => state.toggleFolderCollapsed);
  const lastVisitedAtById = useUiStateStore((state) =>
    node.collapsed ? state.threadLastVisitedAtById : null,
  );
  // A collapsed folder carries its busiest thread's status, like the
  // legacy sidebar's collapsed projects.
  const status = useMemo(() => {
    if (lastVisitedAtById === null) return null;
    return resolveProjectStatusIndicator(
      node.subtreeThreads.map((thread) => {
        const lastVisitedAt =
          lastVisitedAtById[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))];
        return resolveThreadStatusPill({
          thread: { ...thread, ...(lastVisitedAt ? { lastVisitedAt } : {}) },
        });
      }),
    );
  }, [lastVisitedAtById, node.subtreeThreads]);
  const { projects } = props.chatActions;
  const defaultProjectKey = useSidebarFolderStore(
    (state) => resolveSidebarFolderDefaultProject(state, folder.id)?.projectKey ?? null,
  );
  // With a single project there is nothing to pick, same as the header button.
  const directProject =
    (defaultProjectKey === null
      ? null
      : projects.find((project) => project.projectKey === defaultProjectKey)) ??
    (projects.length === 1 ? projects[0]! : null);
  // Opening the folder means the chat is visible once its first message lands.
  const actions: SidebarFolderChatActions = {
    ...props.chatActions,
    startChat: (folderId, projectRef) => {
      if (node.collapsed) toggleFolderCollapsed(folder.id);
      props.chatActions.startChat(folderId, projectRef);
    },
    pickProject: (folderId, purpose) => {
      if (purpose === "chat" && node.collapsed) toggleFolderCollapsed(folder.id);
      props.chatActions.pickProject(folderId, purpose);
    },
  };
  const openMenu = (position: { x: number; y: number }) =>
    void showFolderMenu(folder.id, position, actions);
  const hasContent = node.children.length > 0 || node.rows.length > 0;
  const Icon = node.collapsed ? FolderIcon : FolderOpenIcon;
  return (
    <li
      ref={draggable.setNodeRef}
      data-sidebar-folder={folder.id}
      className={cn("list-none", draggable.isDragging && "relative z-20 opacity-80")}
      style={{ transform: CSS.Translate.toString(draggable.transform) }}
    >
      {zone === "before" ? <DropLine /> : null}
      <div
        ref={droppable.setNodeRef}
        role="button"
        tabIndex={0}
        aria-expanded={!node.collapsed}
        data-thread-selection-safe
        {...draggable.listeners}
        onClick={() => toggleFolderCollapsed(folder.id)}
        onDoubleClick={() => useSidebarFolderUiStore.getState().setRenamingFolderId(folder.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleFolderCollapsed(folder.id);
          }
          if (event.key === "F2") useSidebarFolderUiStore.getState().setRenamingFolderId(folder.id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu({ x: event.clientX, y: event.clientY });
        }}
        className={cn(
          "group/folder flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-sm text-sidebar-foreground/85 select-none hover:bg-sidebar-row-hover",
          zone === "inside" && "bg-primary/8 ring-1 ring-primary/50",
          draggable.isDragging && "bg-sidebar shadow-lg",
        )}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-sidebar-muted-foreground transition-transform",
            !node.collapsed && "rotate-90",
          )}
        />
        <Icon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />
        {isRenaming ? (
          <FolderRenameInput folderId={folder.id} name={folder.name} />
        ) : (
          <span className="min-w-0 flex-1 truncate">{folder.name}</span>
        )}
        {!isRenaming && status ? (
          <span
            role="img"
            aria-label={status.label}
            className={cn("size-1.5 shrink-0 rounded-full", status.dotClass)}
          />
        ) : null}
        {!isRenaming && node.subtreeThreads.length > 0 ? (
          <span className="shrink-0 text-2xs text-sidebar-muted-foreground/70 tabular-nums group-hover/folder:hidden">
            {node.subtreeThreads.length}
          </span>
        ) : null}
        {!isRenaming ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={
                    directProject
                      ? `New chat in ${directProject.displayName}`
                      : `New chat in ${folder.name}`
                  }
                  disabled={projects.length === 0}
                  className="hidden shrink-0 group-hover/folder:inline-flex"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    // Shift or Option picks another project for this one chat.
                    if (directProject && !event.shiftKey && !event.altKey) {
                      actions.startChat(
                        folder.id,
                        scopeProjectRef(directProject.environmentId, directProject.id),
                      );
                      return;
                    }
                    actions.pickProject(folder.id, "chat");
                  }}
                >
                  <SquarePenIcon className="size-3.5" />
                </Button>
              }
            />
            <TooltipPopup side="top">
              {directProject ? (
                <span className="flex flex-col gap-0.5">
                  <span>New chat in {directProject.displayName}</span>
                  {projects.length > 1 ? (
                    <span className="text-muted-foreground">Other project: Shift+click</span>
                  ) : null}
                </span>
              ) : (
                "New chat…"
              )}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {!isRenaming ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Folder actions for ${folder.name}`}
            className="hidden shrink-0 group-hover/folder:inline-flex"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              openMenu({ x: rect.left, y: rect.bottom });
            }}
          >
            <MoreHorizontalIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {zone === "after" ? <DropLine /> : null}
      {hasContent ? (
        <ul
          role="presentation"
          className={cn(
            "flex flex-col gap-px",
            node.depth < MAX_INDENTED_DEPTH && "ml-3 border-l border-sidebar-border/60 pl-1",
          )}
        >
          {node.children.map((child) => (
            <FolderNode
              key={child.folder.id}
              node={child}
              renamingThreadKey={props.renamingThreadKey}
              renderThreadRow={props.renderThreadRow}
              chatActions={props.chatActions}
            />
          ))}
          {node.rows.map((row) => (
            <FolderThreadRow
              key={row.key}
              row={row}
              disabled={props.renamingThreadKey === row.key}
              renderThreadRow={props.renderThreadRow}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The Folders section above Pinned. It sits outside the main list's sortable
 * run (the list's drag preview assumes its sections are contiguous), and its
 * rows join the shared DndContext through useSidebarFolderDnd.
 */
export function SidebarFolderBlock<TThread extends SidebarThreadSummary>(props: {
  roots: ReadonlyArray<SidebarFolderTreeNode<TThread>>;
  /** Hide the section entirely (a project scope with no filed matches). */
  hidden: boolean;
  blockRef: MutableRefObject<HTMLElement | null>;
  renamingThreadKey: string | null;
  renderThreadRow: RenderSidebarFolderThreadRow<TThread>;
  chatActions: SidebarFolderChatActions;
}) {
  const root = useDroppable({ id: SIDEBAR_FOLDER_ROOT_DND_ID });
  const rootIsTarget = useSidebarFolderUiStore((state) => state.dropSlot?.kind === "root");
  const draggingFolder = useSidebarFolderUiStore((state) => state.dragKind === "folder");
  const createFolder = useSidebarFolderStore((state) => state.createFolder);
  const { blockRef } = props;
  const attachBlockRef = useCallback(
    (node: HTMLLIElement | null) => {
      blockRef.current = node;
    },
    [blockRef],
  );
  if (props.hidden) return null;
  return (
    <li ref={attachBlockRef} className="mb-1 list-none" data-thread-selection-safe>
      <div
        ref={root.setNodeRef}
        className={cn(
          "flex h-7 items-center gap-2 rounded-md px-2 text-xs font-medium text-sidebar-muted-foreground/60",
          draggingFolder && "text-sidebar-foreground/80",
          rootIsTarget && "bg-primary/8 text-primary ring-1 ring-primary/50",
        )}
      >
        <span className="shrink-0">
          {draggingFolder ? "Folders (drop for top level)" : "Folders"}
        </span>
        <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-border/60" />
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="New folder"
          onClick={() =>
            useSidebarFolderUiStore
              .getState()
              .setRenamingFolderId(createFolder({ name: "New folder", parentId: null }))
          }
        >
          <FolderPlusIcon className="size-3.5" />
        </Button>
      </div>
      {props.roots.length > 0 ? (
        <ul role="presentation" className="flex flex-col gap-px">
          {props.roots.map((node) => (
            <FolderNode
              key={node.folder.id}
              node={node}
              renamingThreadKey={props.renamingThreadKey}
              renderThreadRow={props.renderThreadRow}
              chatActions={props.chatActions}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
