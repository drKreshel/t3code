import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { Link } from "@tanstack/react-router";
import type { Board } from "@t3tools/contracts";
import { ArchiveRestoreIcon, SquareKanbanIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useBoardsDispatch } from "../../state/boards";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { ticketsByColumn } from "./boards.logic";
import { BoardsPageFrame, BoardsStatusMessage } from "./BoardsPageFrame";
import { columnDotClass } from "./boardsPresentation";
import { NewBoardDialog } from "./NewBoardDialog";
import { useBoardsModel, type TicketView } from "./useBoardsModel";
import { useProjectLookup } from "./useTicketActions";

/** All boards, with what needs Kreshel across them on top. */
export function BoardsIndexPage() {
  const model = useBoardsModel();
  const [creating, setCreating] = useState(false);
  const takenKeys = useMemo(
    () =>
      new Set(
        model.status === "ready"
          ? [...model.boards, ...model.archivedBoards].map((board) => board.key)
          : [],
      ),
    [model],
  );

  return (
    <BoardsPageFrame
      crumbs={[]}
      actions={
        model.status === "ready" ? (
          <Button size="xs" variant="outline" onClick={() => setCreating(true)}>
            <PlusIcon />
            New board
          </Button>
        ) : null
      }
    >
      {model.status === "loading" ? (
        <BoardsStatusMessage>Loading boards…</BoardsStatusMessage>
      ) : model.status === "unavailable" ? (
        <BoardsStatusMessage>
          Boards are unavailable. They need this computer's own server to be running.
        </BoardsStatusMessage>
      ) : (
        <WorkspacePageContainer width="wide">
          {model.needsYou.length > 0 ? <NeedsYouInbox views={model.needsYou} /> : null}
          {model.boards.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SquareKanbanIcon />
                </EmptyMedia>
                <EmptyTitle>No boards yet</EmptyTitle>
                <EmptyDescription>
                  A board plans work as tickets you can start chats from.
                </EmptyDescription>
              </EmptyHeader>
              <Button onClick={() => setCreating(true)}>
                <PlusIcon />
                New board
              </Button>
            </Empty>
          ) : (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-foreground">Boards</h2>
              <ul className="flex flex-col gap-2">
                {model.boards.map((board) => (
                  <BoardRow key={board.id} board={board} views={model.viewById} />
                ))}
              </ul>
            </section>
          )}
          {model.archivedBoards.length > 0 ? (
            <ArchivedBoards boards={model.archivedBoards} />
          ) : null}
        </WorkspacePageContainer>
      )}
      <NewBoardDialog open={creating} onOpenChange={setCreating} takenKeys={takenKeys} />
    </BoardsPageFrame>
  );
}

function NeedsYouInbox({ views }: { readonly views: ReadonlyArray<TicketView> }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
        Needs you
        <Badge variant="warning" size="sm">
          {views.length}
        </Badge>
      </h2>
      <ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60">
        {views.map((view) => (
          <li key={view.ticket.id}>
            <Link
              className="flex min-w-0 items-center gap-3 px-3 py-2 text-sm hover:bg-accent/50"
              to="/boards/$boardKey/$ticketNumber"
              params={{ boardKey: view.board.key, ticketNumber: String(view.ticket.number) }}
            >
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{view.label}</span>
              <span className="min-w-0 truncate">{view.ticket.title}</span>
              <span className="ml-auto min-w-0 shrink truncate text-xs text-warning-foreground">
                {view.attention?.reason}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function BoardRow({
  board,
  views,
}: {
  readonly board: Board;
  readonly views: ReadonlyMap<string, TicketView>;
}) {
  const lookupProject = useProjectLookup();
  const project = lookupProject(board.defaultProjectKey);
  const boardViews = [...views.values()].filter(
    (view) => view.board.id === board.id && view.ticket.archivedAt === null,
  );
  const byColumn = ticketsByColumn(
    board,
    boardViews.map((view) => view.ticket),
  );
  const needsYou = boardViews.filter((view) => view.attention !== null).length;
  const working = boardViews.filter((view) =>
    view.threads.some((thread) => threadRuntimeIsActive(thread.runtime)),
  ).length;
  const lastActivity = boardViews.reduce(
    (latest, view) => (view.ticket.updatedAt > latest ? view.ticket.updatedAt : latest),
    board.updatedAt,
  );

  return (
    <li>
      <Link
        className="flex flex-col gap-2 rounded-lg border border-border/60 px-4 py-3 hover:bg-accent/50"
        to="/boards/$boardKey"
        params={{ boardKey: board.key }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium">{board.name}</span>
          <Badge variant="outline" size="sm">
            {board.key}
          </Badge>
          {needsYou > 0 ? (
            <Badge variant="warning" size="sm">
              {needsYou} need{needsYou === 1 ? "s" : ""} you
            </Badge>
          ) : null}
          {working > 0 ? (
            <Badge variant="info" size="sm">
              {working} working
            </Badge>
          ) : null}
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {formatRelativeTimeLabel(lastActivity)}
          </span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {board.columns.map((column) => (
            <span key={column.id} className="flex items-center gap-1.5">
              <span className={`size-1.5 rounded-full ${columnDotClass(column.color)}`} />
              {column.name}
              <span className="tabular-nums text-foreground">
                {byColumn.get(column.id)?.length ?? 0}
              </span>
            </span>
          ))}
          {project ? <span className="ml-auto truncate">{project.title}</span> : null}
        </div>
      </Link>
    </li>
  );
}

function ArchivedBoards({ boards }: { readonly boards: ReadonlyArray<Board> }) {
  const dispatch = useBoardsDispatch();
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">Archived</h2>
      <ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60">
        {boards.map((board) => (
          <li key={board.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            <Link
              className="min-w-0 truncate text-muted-foreground hover:text-foreground"
              to="/boards/$boardKey"
              params={{ boardKey: board.key }}
            >
              {board.name}
            </Link>
            <Badge variant="outline" size="sm">
              {board.key}
            </Badge>
            <Button
              className="ml-auto"
              size="xs"
              variant="ghost"
              onClick={() =>
                void dispatch({ type: "board.archive", boardId: board.id, archived: false })
              }
            >
              <ArchiveRestoreIcon />
              Restore
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
