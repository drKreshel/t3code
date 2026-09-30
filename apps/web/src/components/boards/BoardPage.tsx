import {
  closestCorners,
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Link } from "@tanstack/react-router";
import type { Automation, Board, BoardColumn } from "@t3tools/contracts";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  EllipsisIcon,
  PauseIcon,
  PlayIcon,
  ZapIcon,
  FolderIcon,
  LockIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "../../lib/utils";
import { useAutomations, useAutomationsDispatch } from "../../state/automations";
import { useBoardsDispatch } from "../../state/boards";
import { AutomationDialog, type AutomationDraft } from "../automations/AutomationDialog";
import { hooksByColumn } from "../automations/automations.logic";
import { resolveProjectStatusIndicator, resolveThreadStatusPill } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { moveStartsTicket, positionBetween, ticketsByColumn } from "./boards.logic";
import { BoardSettingsDialog } from "./BoardSettingsDialog";
import { BoardsPageFrame, BoardsStatusMessage } from "./BoardsPageFrame";
import { COLUMN_TYPE_DOT_CLASS, PRIORITY_LABEL } from "./boardsPresentation";
import { useBoardsModel, type TicketView } from "./useBoardsModel";
import { confirmStartBlocked, pickProjectKey, useProjectLookup } from "./useTicketActions";

/** One board's columns of tickets, with drag between and within columns. */
export function BoardPage({ boardKey }: { readonly boardKey: string }) {
  const model = useBoardsModel();
  const board = model.status === "ready" ? model.index.boardByKey.get(boardKey) : undefined;
  if (model.status !== "ready" || !board) {
    return (
      <BoardsPageFrame crumbs={[{ label: boardKey }]}>
        <BoardsStatusMessage>
          {model.status === "loading"
            ? "Loading board…"
            : model.status === "unavailable"
              ? "Boards are unavailable. They need this computer's own server to be running."
              : `There is no board with the key ${boardKey}.`}
        </BoardsStatusMessage>
      </BoardsPageFrame>
    );
  }
  return <BoardView board={board} viewById={model.viewById} />;
}

/** The column new tickets land in: the first backlog or todo column. */
function defaultColumnId(board: Board): string | null {
  const rank = (column: BoardColumn) =>
    column.type === "backlog" ? 0 : column.type === "todo" ? 1 : 2;
  const sorted = board.columns.toSorted((a, b) => rank(a) - rank(b) || a.position - b.position);
  return sorted[0]?.id ?? null;
}

function BoardView({
  board,
  viewById,
}: {
  readonly board: Board;
  readonly viewById: ReadonlyMap<string, TicketView>;
}) {
  const dispatch = useBoardsDispatch();
  const lookupProject = useProjectLookup();
  const defaultProject = lookupProject(board.defaultProjectKey);
  const [addingColumnId, setAddingColumnId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const automations = useAutomations();
  const automationsDispatch = useAutomationsDispatch();
  const [hookDialog, setHookDialog] = useState<{
    readonly automation: Automation | null;
    readonly draft: AutomationDraft | null;
  } | null>(null);
  const hooks = useMemo(
    () =>
      automations.status === "ready"
        ? hooksByColumn(automations.snapshot.automations, board.id)
        : new Map<string, Automation[]>(),
    [automations, board.id],
  );
  const hooksPaused =
    automations.status === "ready" &&
    automations.snapshot.boardHooks.some((state) => state.boardId === board.id && state.paused);
  const columns = useMemo(
    () => board.columns.toSorted((a, b) => a.position - b.position),
    [board.columns],
  );
  const byColumn = useMemo(
    () =>
      ticketsByColumn(
        board,
        [...viewById.values()].map((view) => view.ticket),
      ),
    [board, viewById],
  );
  const needsYou = [...viewById.values()].filter(
    (view) => view.board.id === board.id && view.attention !== null,
  ).length;

  // While dragging, the board renders this order so cards make room as the
  // pointer moves; the drop writes one move and the snapshot takes over.
  const [dragOrder, setDragOrder] = useState<Map<string, string[]> | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const justDraggedRef = useRef(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const order =
    dragOrder ??
    new Map(
      [...byColumn.entries()].map(([columnId, tickets]) => [
        columnId,
        tickets.map((ticket) => ticket.id),
      ]),
    );
  const columnOf = (id: string, current: Map<string, string[]>) => {
    if (current.has(id)) return id;
    for (const [columnId, ids] of current) if (ids.includes(id)) return columnId;
    return null;
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
    setDragOrder(order);
  };
  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over || !dragOrder) return;
    const activeKey = String(active.id);
    const overKey = String(over.id);
    const from = columnOf(activeKey, dragOrder);
    const to = columnOf(overKey, dragOrder);
    if (!from || !to || from === to) return;
    const next = new Map(dragOrder);
    next.set(
      from,
      next.get(from)!.filter((id) => id !== activeKey),
    );
    const target = [...next.get(to)!];
    const overIndex = target.indexOf(overKey);
    target.splice(overIndex === -1 ? target.length : overIndex, 0, activeKey);
    next.set(to, target);
    setDragOrder(next);
  };
  const handleDragEnd = async (event: DragEndEvent) => {
    const current = dragOrder;
    setActiveId(null);
    justDraggedRef.current = true;
    window.setTimeout(() => {
      justDraggedRef.current = false;
    }, 0);
    const { active, over } = event;
    const activeKey = String(active.id);
    const view = viewById.get(activeKey);
    if (!current || !over || !view) {
      setDragOrder(null);
      return;
    }
    const columnId = columnOf(activeKey, current);
    if (!columnId) {
      setDragOrder(null);
      return;
    }
    // Within a column, dropping on a card takes that card's place.
    const overKey = String(over.id);
    let ids = current.get(columnId)!;
    if (overKey !== activeKey && ids.includes(overKey)) {
      ids = arrayMove(ids, ids.indexOf(activeKey), ids.indexOf(overKey));
    }
    setDragOrder(new Map(current).set(columnId, ids));
    const index = ids.indexOf(activeKey);
    const originalIndex = byColumn.get(view.ticket.columnId)?.indexOf(view.ticket) ?? -1;
    const unchanged = columnId === view.ticket.columnId && index === originalIndex;
    const neighbour = (offset: number) => {
      const id = ids[index + offset];
      return id === undefined ? undefined : viewById.get(id)?.ticket.position;
    };
    const toType = board.columns.find((column) => column.id === columnId)?.type;
    let overrideBlocked = false;
    if (toType && columnId !== view.ticket.columnId && moveStartsTicket(view.columnType, toType)) {
      if (view.blockers.length > 0) {
        if (!(await confirmStartBlocked(view))) {
          setDragOrder(null);
          return;
        }
        overrideBlocked = true;
      }
    }
    if (!unchanged) {
      await dispatch({
        type: "ticket.move",
        ticketId: activeKey,
        columnId,
        position: positionBetween(neighbour(-1), neighbour(1)),
        ...(overrideBlocked ? { overrideBlocked } : {}),
      });
    }
    setDragOrder(null);
  };

  const activeView = activeId ? viewById.get(activeId) : undefined;

  return (
    <BoardsPageFrame
      scroll={false}
      crumbs={[{ label: board.name }]}
      actions={
        <>
          {needsYou > 0 ? (
            <Badge variant="warning" size="sm">
              {needsYou} need{needsYou === 1 ? "s" : ""} you
            </Badge>
          ) : null}
          <Menu>
            <MenuTrigger render={<Button size="xs" variant="ghost" />}>
              <FolderIcon />
              <span className="max-w-40 truncate">
                {defaultProject?.title ?? "No default project"}
              </span>
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem
                onClick={() =>
                  pickProjectKey(
                    (projectKey) =>
                      void dispatch({
                        type: "board.update",
                        boardId: board.id,
                        defaultProjectKey: projectKey,
                      }),
                  )
                }
              >
                {board.defaultProjectKey === null
                  ? "Set default project…"
                  : "Change default project…"}
              </MenuItem>
              {board.defaultProjectKey !== null ? (
                <MenuItem
                  onClick={() =>
                    void dispatch({
                      type: "board.update",
                      boardId: board.id,
                      defaultProjectKey: null,
                    })
                  }
                >
                  Clear default project
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
          <Button
            size="xs"
            variant="outline"
            disabled={board.archivedAt !== null}
            onClick={() => setAddingColumnId(defaultColumnId(board))}
          >
            <PlusIcon />
            New ticket
          </Button>
          <Menu>
            <MenuTrigger
              render={<Button aria-label="Board actions" size="icon-xs" variant="ghost" />}
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => setSettingsOpen(true)}>
                <SettingsIcon />
                Board settings
              </MenuItem>
              <MenuItem
                onClick={() => setHookDialog({ automation: null, draft: { boardId: board.id } })}
              >
                <ZapIcon />
                Add hook…
              </MenuItem>
              {hooks.size > 0 ? (
                <MenuItem
                  onClick={() =>
                    void automationsDispatch({
                      type: "board.pauseHooks",
                      boardId: board.id,
                      paused: !hooksPaused,
                    })
                  }
                >
                  {hooksPaused ? <PlayIcon /> : <PauseIcon />}
                  {hooksPaused ? "Resume hooks" : "Pause hooks"}
                </MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem
                onClick={() =>
                  void dispatch({
                    type: "board.archive",
                    boardId: board.id,
                    archived: board.archivedAt === null,
                  })
                }
              >
                {board.archivedAt === null ? <ArchiveIcon /> : <ArchiveRestoreIcon />}
                {board.archivedAt === null ? "Archive board" : "Restore board"}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </>
      }
    >
      {board.archivedAt !== null ? (
        <p className="border-b border-border/60 px-6 py-2 text-sm text-muted-foreground">
          This board is archived. Restore it from the board menu to change it.
        </p>
      ) : null}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={(event) => void handleDragEnd(event)}
        onDragCancel={() => {
          setActiveId(null);
          setDragOrder(null);
        }}
      >
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-(--workspace-gutter-start) pt-2 pb-4">
          {columns.map((column) => (
            <BoardColumnView
              key={column.id}
              board={board}
              column={column}
              views={(order.get(column.id) ?? []).flatMap((id) => {
                const view = viewById.get(id);
                return view ? [view] : [];
              })}
              adding={addingColumnId === column.id}
              onAddingChange={(adding) => setAddingColumnId(adding ? column.id : null)}
              justDraggedRef={justDraggedRef}
              hooks={hooks.get(column.id) ?? []}
              hooksPaused={hooksPaused}
              onEditHook={(automation) => setHookDialog({ automation, draft: null })}
              onAddHook={() =>
                setHookDialog({
                  automation: null,
                  draft: { boardId: board.id, columnId: column.id },
                })
              }
            />
          ))}
        </div>
        <DragOverlay>{activeView ? <TicketCard view={activeView} overlay /> : null}</DragOverlay>
      </DndContext>
      <BoardSettingsDialog board={board} open={settingsOpen} onOpenChange={setSettingsOpen} />
      <AutomationDialog
        open={hookDialog !== null}
        onOpenChange={(open) => {
          if (!open) setHookDialog(null);
        }}
        automation={hookDialog?.automation ?? null}
        draft={hookDialog?.draft ?? null}
      />
    </BoardsPageFrame>
  );
}

function BoardColumnView({
  board,
  column,
  views,
  adding,
  onAddingChange,
  justDraggedRef,
  hooks,
  hooksPaused,
  onEditHook,
  onAddHook,
}: {
  readonly board: Board;
  readonly column: BoardColumn;
  readonly views: ReadonlyArray<TicketView>;
  readonly adding: boolean;
  readonly onAddingChange: (adding: boolean) => void;
  readonly justDraggedRef: { readonly current: boolean };
  /** Automations that run when a ticket enters this column. */
  readonly hooks: ReadonlyArray<Automation>;
  readonly hooksPaused: boolean;
  readonly onEditHook: (automation: Automation) => void;
  readonly onAddHook: () => void;
}) {
  const { setNodeRef } = useDroppable({ id: column.id });
  const highlighted = column.type === "attention" && views.length > 0;
  return (
    <section
      aria-label={column.name}
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-lg bg-muted/40",
        highlighted && "bg-warning/8 ring-1 ring-warning/30 dark:bg-warning/12",
      )}
    >
      <header className="flex items-center gap-2 px-3 pt-2.5 pb-2 text-sm">
        <span className={cn("size-2 shrink-0 rounded-full", COLUMN_TYPE_DOT_CLASS[column.type])} />
        <h2 className="min-w-0 truncate font-medium">{column.name}</h2>
        <span className="text-xs tabular-nums text-muted-foreground">{views.length}</span>
        {board.archivedAt === null ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  aria-label={
                    hooks.length > 0
                      ? `${hooks.length} hook${hooks.length === 1 ? "" : "s"} on ${column.name}${hooksPaused ? " (paused)" : ""}`
                      : `Add a hook to ${column.name}`
                  }
                  className="ml-auto"
                  size={hooks.length > 0 ? "xs" : "icon-xs"}
                  variant={hooks.length > 0 && !hooksPaused ? "secondary" : "ghost"}
                />
              }
            >
              <ZapIcon />
              {hooks.length > 0 ? hooks.length : null}
            </MenuTrigger>
            <MenuPopup align="end">
              {hooks.map((automation) => (
                <MenuItem key={automation.id} onClick={() => onEditHook(automation)}>
                  {automation.title}
                  {automation.enabled ? "" : " (off)"}
                </MenuItem>
              ))}
              {hooks.length > 0 ? <MenuSeparator /> : null}
              <MenuItem onClick={onAddHook}>Add hook to {column.name}…</MenuItem>
            </MenuPopup>
          </Menu>
        ) : null}
        {board.archivedAt === null ? (
          <Button
            aria-label={`Add ticket to ${column.name}`}
            size="icon-xs"
            variant="ghost"
            onClick={() => onAddingChange(true)}
          >
            <PlusIcon />
          </Button>
        ) : null}
      </header>
      <SortableContext
        items={views.map((view) => view.ticket.id)}
        strategy={verticalListSortingStrategy}
      >
        <ol
          ref={setNodeRef}
          className="flex min-h-12 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2"
        >
          {views.map((view) => (
            <SortableTicket
              key={view.ticket.id}
              view={view}
              disabled={board.archivedAt !== null}
              justDraggedRef={justDraggedRef}
            />
          ))}
          {adding ? (
            <NewTicketInput board={board} column={column} onDone={() => onAddingChange(false)} />
          ) : null}
        </ol>
      </SortableContext>
    </section>
  );
}

function NewTicketInput({
  board,
  column,
  onDone,
}: {
  readonly board: Board;
  readonly column: BoardColumn;
  readonly onDone: () => void;
}) {
  const dispatch = useBoardsDispatch();
  const [title, setTitle] = useState("");
  const create = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setTitle("");
    await dispatch({
      type: "ticket.create",
      boardId: board.id,
      columnId: column.id,
      title: trimmed,
    });
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void create();
    } else if (event.key === "Escape") {
      onDone();
    }
  };
  return (
    <li>
      <Input
        autoFocus
        size="sm"
        aria-label="Ticket title"
        placeholder="Ticket title, then Enter"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (!title.trim()) onDone();
        }}
      />
    </li>
  );
}

function SortableTicket({
  view,
  disabled,
  justDraggedRef,
}: {
  readonly view: TicketView;
  readonly disabled: boolean;
  readonly justDraggedRef: { readonly current: boolean };
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: view.ticket.id,
    disabled,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && "opacity-40")}
      {...attributes}
      {...listeners}
    >
      <Link
        to="/boards/$boardKey/$ticketNumber"
        params={{ boardKey: view.board.key, ticketNumber: String(view.ticket.number) }}
        onClick={(event) => {
          if (justDraggedRef.current) event.preventDefault();
        }}
        draggable={false}
        className="block rounded-md outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        <TicketCard view={view} />
      </Link>
    </li>
  );
}

function TicketCard({
  view,
  overlay = false,
}: {
  readonly view: TicketView;
  readonly overlay?: boolean;
}) {
  const lookupProject = useProjectLookup();
  const { ticket } = view;
  const project = ticket.projectKey === null ? null : lookupProject(ticket.projectKey);
  const checked = ticket.criteria.filter((criterion) => criterion.checked).length;
  const status = resolveProjectStatusIndicator(
    view.threads.map((thread) => resolveThreadStatusPill({ thread })),
  );
  return (
    <article
      className={cn(
        "flex flex-col gap-1.5 rounded-md border border-border/60 bg-card px-3 py-2 text-sm shadow-xs/5 hover:border-border",
        overlay && "rotate-1 shadow-lg",
      )}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">{view.label}</span>
        {status ? (
          <span className={cn("size-1.5 shrink-0 rounded-full", status.dotClass)}>
            <span className="sr-only">{status.label}</span>
          </span>
        ) : null}
        {ticket.priority !== "none" ? (
          <span
            className={cn("ml-auto", ticket.priority === "urgent" && "text-destructive-foreground")}
          >
            {PRIORITY_LABEL[ticket.priority]}
          </span>
        ) : null}
      </div>
      <p className="line-clamp-3 text-foreground">{ticket.title}</p>
      {view.attention || view.blockers.length > 0 || ticket.criteria.length > 0 || project ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {view.attention ? (
            <Badge variant="warning" size="sm">
              Needs you
            </Badge>
          ) : null}
          {view.blockers.length > 0 ? (
            <Badge variant="outline" size="sm">
              <LockIcon />
              {view.blockerLabels.join(", ")}
            </Badge>
          ) : null}
          {ticket.criteria.length > 0 ? (
            <span className="tabular-nums">
              {checked}/{ticket.criteria.length}
            </span>
          ) : null}
          {project ? <span className="ml-auto truncate">{project.title}</span> : null}
        </div>
      ) : null}
      {view.attention?.kind === "attention" && ticket.attentionReason ? (
        <p className="line-clamp-2 text-xs text-warning-foreground">{ticket.attentionReason}</p>
      ) : null}
    </article>
  );
}
