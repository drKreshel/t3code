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
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { Link } from "@tanstack/react-router";
import type { Board, BoardColumn } from "@t3tools/contracts";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  EllipsisIcon,
  ZapIcon,
  FolderIcon,
  LinkIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "../../lib/utils";
import { useBoardsDispatch } from "../../state/boards";
import { resolveProjectStatusIndicator, resolveThreadStatusPill } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { positionBetween, ticketsByColumn } from "./boards.logic";
import { BoardSettingsDialog } from "./BoardSettingsDialog";
import { BoardsPageFrame, BoardsStatusMessage } from "./BoardsPageFrame";
import { columnDotClass, PRIORITY_LABEL } from "./boardsPresentation";
import { useBoardsModel, type TicketView } from "./useBoardsModel";
import { usePickProjectKey, useProjectLookup } from "./useTicketActions";

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

/** The column new tickets land in: the first one. */
function defaultColumnId(board: Board): string | null {
  return board.columns.toSorted((a, b) => a.position - b.position)[0]?.id ?? null;
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
  const pickProjectKey = usePickProjectKey();
  const defaultProject = lookupProject(board.defaultProjectKey);
  const [addingColumnId, setAddingColumnId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
    // Moving a ticket records progress; execution starts explicitly from its workflow.
    if (!unchanged) {
      await dispatch({
        type: "ticket.move",
        ticketId: activeKey,
        columnId,
        position: positionBetween(neighbour(-1), neighbour(1)),
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
              <MenuItem render={<Link to="/automations" search={{ tab: "workflows" }} />}>
                <ZapIcon />
                Workflows
              </MenuItem>
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
            />
          ))}
        </div>
        <DragOverlay>{activeView ? <TicketCard view={activeView} overlay /> : null}</DragOverlay>
      </DndContext>
      <BoardSettingsDialog board={board} open={settingsOpen} onOpenChange={setSettingsOpen} />
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
}: {
  readonly board: Board;
  readonly column: BoardColumn;
  readonly views: ReadonlyArray<TicketView>;
  readonly adding: boolean;
  readonly onAddingChange: (adding: boolean) => void;
  readonly justDraggedRef: { readonly current: boolean };
}) {
  const { setNodeRef } = useDroppable({ id: column.id });
  return (
    <section
      aria-label={column.name}
      className="flex w-72 shrink-0 flex-col rounded-lg bg-muted/40"
    >
      <header className="flex items-center gap-2 px-3 pt-2.5 pb-2 text-sm">
        <span className={cn("size-2 shrink-0 rounded-full", columnDotClass(column.color))} />
        <h2 className="min-w-0 truncate font-medium">{column.name}</h2>
        <span className="text-xs tabular-nums text-muted-foreground">{views.length}</span>
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
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
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
      <TicketCard view={view} justDraggedRef={justDraggedRef} />
    </li>
  );
}

function TicketCard({
  view,
  overlay = false,
  justDraggedRef,
}: {
  readonly view: TicketView;
  readonly overlay?: boolean;
  readonly justDraggedRef?: { readonly current: boolean };
}) {
  const lookupProject = useProjectLookup();
  const { ticket } = view;
  const project = ticket.projectKey === null ? null : lookupProject(ticket.projectKey);
  const checked = ticket.criteria.filter((criterion) => criterion.checked).length;
  const status = resolveProjectStatusIndicator(
    view.threads.map((thread) => resolveThreadStatusPill({ thread })),
  );
  const runningSessions = view.threads.filter(
    (thread) =>
      threadRuntimeIsActive(thread.runtime) ||
      thread.hasPendingApprovals ||
      thread.hasPendingUserInput ||
      thread.pendingBackgroundTasks.length > 0,
  );
  const lastSession =
    runningSessions.length === 0
      ? view.threads.reduce(
          (latest, thread) => (!latest || thread.updatedAt > latest.updatedAt ? thread : latest),
          view.threads[0],
        )
      : undefined;
  const visibleSessions =
    runningSessions.length > 0 ? runningSessions : lastSession ? [lastSession] : [];
  return (
    <article
      className={cn(
        "relative flex flex-col gap-1.5 rounded-md border border-border/60 bg-card px-3 py-2 text-sm shadow-xs/5 hover:border-border",
        overlay && "rotate-1 shadow-lg",
      )}
    >
      {!overlay ? (
        <Link
          to="/boards/$boardKey/$ticketNumber"
          params={{ boardKey: view.board.key, ticketNumber: String(ticket.number) }}
          aria-label={`Open ticket ${view.label}: ${ticket.title}`}
          draggable={false}
          className="absolute inset-0 rounded-md outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => {
            if (justDraggedRef?.current) event.preventDefault();
          }}
        />
      ) : null}
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
      {ticket.workflow ? (
        <p className="truncate text-xs text-muted-foreground">{ticket.workflow.title}</p>
      ) : null}
      {view.requirements.length > 0 || ticket.criteria.length > 0 || project ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {view.requirements.length > 0 ? (
            <Badge variant="outline" size="sm">
              <LinkIcon />
              {view.requirements
                .map((requirement) => `${requirement.label} · ${requirement.columnName}`)
                .join(", ")}
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
      {view.attention && !view.attention.threadKey ? (
        <p
          className={cn(
            "line-clamp-2 text-xs",
            view.attention.level === "error"
              ? "text-destructive-foreground"
              : "text-warning-foreground",
          )}
        >
          {view.attention.reason}
        </p>
      ) : null}
      {visibleSessions.length > 0 ? (
        <ul
          aria-label={runningSessions.length > 0 ? "Running sessions" : "Last session"}
          className="pointer-events-none relative z-10 mt-1 flex min-w-0 flex-col border-t border-border/60 pt-1"
        >
          {visibleSessions.map((thread) => {
            const sessionStatus = resolveThreadStatusPill({ thread });
            return (
              <li key={`${thread.environmentId}:${thread.id}`} className="min-w-0">
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId: thread.environmentId, threadId: thread.id }}
                  title={thread.blockingReason ?? thread.title}
                  draggable={false}
                  tabIndex={overlay ? -1 : undefined}
                  className="pointer-events-auto flex min-w-0 items-center gap-1.5 rounded-sm px-1 py-1 text-xs hover:bg-accent/50 outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    if (justDraggedRef?.current) event.preventDefault();
                  }}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      sessionStatus?.dotClass ?? "bg-muted-foreground/30",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                  <span
                    className={cn("shrink-0", sessionStatus?.colorClass ?? "text-muted-foreground")}
                  >
                    {sessionStatus?.label ?? "Last session"}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </article>
  );
}
