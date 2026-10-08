import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { Link, useLocation } from "@tanstack/react-router";
import type { Board } from "@t3tools/contracts";
import { SquareKanbanIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { useBoardsDispatch } from "../../state/boards";
import { useSidebar } from "../ui/sidebar";
import { useBoardsModel } from "./useBoardsModel";

/** Quick links to pinned boards, above the sidebar's Folders. */
export const SidebarPinnedBoards = memo(function SidebarPinnedBoards() {
  const model = useBoardsModel();
  const { pinned, needsYouByBoardId } = useMemo(() => {
    if (model.status !== "ready") return { pinned: [], needsYouByBoardId: new Map() };
    const counts = new Map<string, number>();
    for (const view of model.needsYou) {
      counts.set(view.board.id, (counts.get(view.board.id) ?? 0) + 1);
    }
    return {
      pinned: model.boards.filter((board) => board.pinnedAt !== null),
      needsYouByBoardId: counts,
    };
  }, [model]);
  if (pinned.length === 0) return null;
  return (
    <li className="mb-1 list-none" data-thread-selection-safe>
      <div className="flex h-7 items-center gap-2 rounded-md px-2 text-xs font-medium text-sidebar-muted-foreground/60">
        <span className="shrink-0">Boards</span>
        <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-border/60" />
      </div>
      <ul role="presentation" className="flex flex-col gap-px">
        {pinned.map((board) => (
          <PinnedBoardRow
            key={board.id}
            board={board}
            needsYou={needsYouByBoardId.get(board.id) ?? 0}
          />
        ))}
      </ul>
    </li>
  );
});

function PinnedBoardRow({ board, needsYou }: { readonly board: Board; readonly needsYou: number }) {
  const dispatch = useBoardsDispatch();
  const { isMobile, setOpenMobile } = useSidebar();
  // Only the board segment, so switching threads does not re-render the row.
  const active = useLocation({
    select: (location) => {
      const [, page, key] = location.pathname.split("/");
      return page === "boards" && key === board.key;
    },
  });
  const showMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const clicked = await settlePromise(() =>
      api.contextMenu.show(
        [{ id: "unpin", label: "Unpin from sidebar", icon: "pin-off" }],
        position,
      ),
    );
    if (clicked._tag === "Success" && clicked.value === "unpin") {
      void dispatch({ type: "board.update", boardId: board.id, pinned: false });
    }
  };
  return (
    <li className="list-none">
      <Link
        to="/boards/$boardKey"
        params={{ boardKey: board.key }}
        onClick={() => {
          if (isMobile) setOpenMobile(false);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          void showMenu({ x: event.clientX, y: event.clientY });
        }}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-md px-1.5 text-sm text-sidebar-foreground/85 select-none hover:bg-sidebar-row-hover",
          active && "bg-sidebar-row-active text-sidebar-foreground",
        )}
      >
        <SquareKanbanIcon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{board.name}</span>
        {needsYou > 0 ? (
          <span
            aria-label={`${needsYou} need${needsYou === 1 ? "s" : ""} you`}
            className="shrink-0 text-2xs font-medium text-warning tabular-nums"
          >
            {needsYou}
          </span>
        ) : (
          <span className="shrink-0 text-2xs text-sidebar-muted-foreground/70">{board.key}</span>
        )}
      </Link>
    </li>
  );
}
