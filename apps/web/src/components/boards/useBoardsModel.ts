import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { Board, Ticket } from "@t3tools/contracts";
import { useMemo } from "react";

import { useBoards } from "../../state/boards";
import { useThreadShells } from "../../state/entities";
import {
  indexBoards,
  ticketAttention,
  ticketKey,
  ticketRequirements,
  type BoardsIndex,
  type TicketAttention,
  type TicketRequirement,
} from "./boards.logic";

/** A ticket with everything the boards screens show about it. */
export interface TicketView {
  readonly ticket: Ticket;
  readonly board: Board;
  readonly label: string;
  /** Tickets this one requires, with the column each sits in. */
  readonly requirements: ReadonlyArray<TicketRequirement>;
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
      const threads = ticket.threadKeys.flatMap((key) => {
        const shell = shellByKey.get(key);
        return shell && shell.archivedAt === null ? [shell] : [];
      });
      viewById.set(ticket.id, {
        ticket,
        board,
        label: ticketKey(board, ticket),
        requirements: ticketRequirements(ticket, index),
        attention:
          board.archivedAt === null
            ? ticketAttention(
                ticket,
                threads.map((thread) => ({
                  hasPendingApprovals: thread.hasPendingApprovals,
                  hasPendingUserInput: thread.hasPendingUserInput,
                  sessionError:
                    thread.runtime?.status === "failed"
                      ? (thread.runtime.lastError ?? "The chat stopped with an error")
                      : null,
                })),
              )
            : null,
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
        // Errors first, then oldest first.
        .toSorted(
          (a, b) =>
            Number(b.attention?.level === "error") - Number(a.attention?.level === "error") ||
            a.ticket.updatedAt.localeCompare(b.ticket.updatedAt),
        ),
    };
  }, [shells, state]);
}

/** How many tickets need Kreshel, for the sidebar's Boards button. */
export function useBoardsNeedsYouCount(): number {
  const model = useBoardsModel();
  return model.status === "ready" ? model.needsYou.length : 0;
}
