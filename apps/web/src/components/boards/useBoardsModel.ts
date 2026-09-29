import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { Board, BoardColumnType, Ticket } from "@t3tools/contracts";
import { useMemo } from "react";

import { useBoards } from "../../state/boards";
import { useThreadShells } from "../../state/entities";
import {
  indexBoards,
  ticketAttention,
  ticketBlockers,
  ticketKey,
  ticketLabel,
  type BoardsIndex,
  type TicketAttention,
} from "./boards.logic";

/** A ticket with everything the boards screens show about it. */
export interface TicketView {
  readonly ticket: Ticket;
  readonly board: Board;
  readonly label: string;
  readonly columnType: BoardColumnType | undefined;
  readonly blockers: ReadonlyArray<Ticket>;
  /** Keys of the blockers, like `WEB-3`. */
  readonly blockerLabels: ReadonlyArray<string>;
  readonly attention: TicketAttention | null;
  /** Linked chats this client knows about; chats of disconnected environments are missing. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

export type BoardsModel =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly boards: ReadonlyArray<Board>;
      readonly archivedBoards: ReadonlyArray<Board>;
      readonly index: BoardsIndex;
      readonly viewById: ReadonlyMap<string, TicketView>;
      /** Tickets waiting on Kreshel across all boards, oldest first. */
      readonly needsYou: ReadonlyArray<TicketView>;
    };

/**
 * Boards joined with live chat state, so "needs you" also covers linked chats
 * waiting on an approval or an answer.
 */
export function useBoardsModel(): BoardsModel {
  const state = useBoards();
  const shells = useThreadShells();
  return useMemo((): BoardsModel => {
    if (state.status === "loading") return { status: "loading" };
    if (state.status === "unavailable") return { status: "unavailable" };
    const { snapshot } = state;
    const index = indexBoards(snapshot);
    const shellByKey = new Map(
      shells.map((shell) => [
        scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id)),
        shell,
      ]),
    );
    const viewById = new Map<string, TicketView>();
    for (const ticket of snapshot.tickets) {
      const board = index.boardById.get(ticket.boardId);
      if (!board) continue;
      const columnType = index.columnTypeById.get(ticket.columnId);
      const threads = ticket.threadKeys.flatMap((key) => {
        const shell = shellByKey.get(key);
        return shell && shell.archivedAt === null ? [shell] : [];
      });
      const blockers = ticketBlockers(ticket, index);
      viewById.set(ticket.id, {
        ticket,
        board,
        label: ticketKey(board, ticket),
        columnType,
        blockers,
        blockerLabels: blockers.map((blocker) => ticketLabel(blocker, index)),
        attention: board.archivedAt === null ? ticketAttention(ticket, columnType, threads) : null,
        threads,
      });
    }
    const byPosition = (a: Board, b: Board) => a.position - b.position;
    return {
      status: "ready",
      boards: snapshot.boards.filter((board) => board.archivedAt === null).toSorted(byPosition),
      archivedBoards: snapshot.boards
        .filter((board) => board.archivedAt !== null)
        .toSorted(byPosition),
      index,
      viewById,
      needsYou: [...viewById.values()]
        .filter((view) => view.attention !== null)
        .toSorted((a, b) => a.ticket.updatedAt.localeCompare(b.ticket.updatedAt)),
    };
  }, [shells, state]);
}

/** How many tickets need Kreshel, for the sidebar's Boards button. */
export function useBoardsNeedsYouCount(): number {
  const model = useBoardsModel();
  return model.status === "ready" ? model.needsYou.length : 0;
}
