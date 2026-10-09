import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId, ProjectIconOverride } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { SquareKanbanIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { OrganizingIcon } from "../OrganizingIcon";
import { useBoards, useBoardsDispatch, useThreadTicketKey } from "../../state/boards";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { recentBoardsByActivity, ticketKey } from "./boards.logic";

const RECENT_BOARD_COUNT = 5;
const OPEN = "\u0000open";
const UNLINK = "\u0000unlink";
/** Board rows open the board; their values carry the board key. */
const BOARD_PREFIX = "\u0000board:";

interface TicketCandidate {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly boardName: string;
}

interface BoardCandidate {
  readonly icon: ProjectIconOverride | null;
  readonly key: string;
  readonly name: string;
  readonly openTickets: number;
}

function SectionLabel({ children }: { readonly children: ReactNode }) {
  return <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">{children}</div>;
}

/**
 * The chat header's ticket: shows the linked ticket's key and links, changes,
 * or unlinks it, and opens boards. Works for drafts too, since a draft's
 * thread id is its future server thread's.
 */
export function ThreadTicketChip({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadKey = scopedThreadKey(scopeThreadRef(environmentId, threadId));
  const linkedKey = useThreadTicketKey(threadKey);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const boards = useBoards();
  const dispatch = useBoardsDispatch();
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canLink = environmentId === primaryEnvironmentId;

  // Built only while the picker is open; the closed chip reads one string.
  const { boardCandidates, ticketCandidates } = useMemo(() => {
    if (!open || !canLink || boards.status !== "ready") {
      return { boardCandidates: [] as BoardCandidate[], ticketCandidates: [] as TicketCandidate[] };
    }
    const { snapshot } = boards;
    const needle = query.trim().toLowerCase();
    // Most recently active first, so tickets follow the same order as the boards above them.
    const liveBoards = recentBoardsByActivity(snapshot, Number.POSITIVE_INFINITY);
    const boardMatches = (board: (typeof liveBoards)[number]) =>
      board.name.toLowerCase().includes(needle) || board.key.toLowerCase().includes(needle);
    // Empty query: the most recently active boards; otherwise every matching board.
    const shownBoards =
      needle === "" ? liveBoards.slice(0, RECENT_BOARD_COUNT) : liveBoards.filter(boardMatches);
    const openTickets = (boardId: string) =>
      snapshot.tickets.filter((ticket) => ticket.boardId === boardId && ticket.archivedAt === null)
        .length;
    return {
      boardCandidates: shownBoards.map((board) => ({
        key: board.key,
        icon: board.icon ?? null,
        name: board.name,
        openTickets: openTickets(board.id),
      })),
      ticketCandidates: liveBoards.flatMap((board) => {
        // A query naming the board lists all of its tickets.
        const wholeBoard = needle !== "" && boardMatches(board);
        return snapshot.tickets
          .filter((ticket) => ticket.boardId === board.id && ticket.archivedAt === null)
          .toSorted((a, b) => b.number - a.number)
          .map((ticket) => ({
            id: ticket.id,
            label: ticketKey(board, ticket),
            title: ticket.title,
            boardName: board.name,
          }))
          .filter(
            (candidate) =>
              needle === "" ||
              wholeBoard ||
              candidate.label.toLowerCase().includes(needle) ||
              candidate.title.toLowerCase().includes(needle),
          );
      }),
    };
  }, [boards, canLink, open, query]);

  const actions = linkedKey === null ? [] : [OPEN, UNLINK];
  const boardValues = boardCandidates.map((board) => `${BOARD_PREFIX}${board.key}`);
  const keys = [...actions, ...boardValues, ...ticketCandidates.map((ticket) => ticket.id)];

  const openTicket = (label: string) => {
    const separator = label.lastIndexOf("-");
    void navigate({
      to: "/boards/$boardKey/$ticketNumber",
      params: { boardKey: label.slice(0, separator), ticketNumber: label.slice(separator + 1) },
    });
  };

  const handlePick = (key: string) => {
    if (key === OPEN && linkedKey !== null) openTicket(linkedKey);
    else if (key === UNLINK) void dispatch({ type: "thread.link", threadKey, ticketId: null });
    else if (key.startsWith(BOARD_PREFIX)) {
      void navigate({
        to: "/boards/$boardKey",
        params: { boardKey: key.slice(BOARD_PREFIX.length) },
      });
    } else if (canLink) void dispatch({ type: "thread.link", threadKey, ticketId: key });
  };

  // Keep existing links accessible for opening and unlinking; new links need
  // a chat on the server whose tools can read the ticket.
  if (!canLink && linkedKey === null) return null;

  const trigger =
    linkedKey === null ? (
      <Button size="icon-xs" variant="ghost" aria-label="Link this chat to a ticket">
        <SquareKanbanIcon />
      </Button>
    ) : (
      <Button size="xs" variant="ghost" aria-label={`Ticket ${linkedKey}`}>
        <SquareKanbanIcon />
        {linkedKey}
      </Button>
    );

  return (
    <Combobox
      items={keys}
      filteredItems={keys}
      filter={null}
      autoHighlight
      value={null}
      onValueChange={(key) => {
        if (typeof key === "string") handlePick(key);
      }}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <ComboboxTrigger render={trigger} />
      <ComboboxPopup align="start" side="bottom" className="w-80">
        <ComboboxSearchInput
          aria-label="Search tickets and boards"
          placeholder="Search tickets or boards"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxList className="max-h-96">
          {linkedKey !== null ? (
            <>
              <ComboboxItem hideIndicator index={0} value={OPEN}>
                Open {linkedKey}
              </ComboboxItem>
              <ComboboxItem hideIndicator index={1} value={UNLINK}>
                Unlink from {linkedKey}
              </ComboboxItem>
            </>
          ) : null}
          {boards.status !== "ready" ? (
            <p className="p-2 text-xs text-muted-foreground">
              {boards.status === "loading" ? "Loading boards…" : "Boards are unavailable."}
            </p>
          ) : (
            <>
              {boardCandidates.length > 0 ? (
                <>
                  <SectionLabel>{query.trim() ? "Boards" : "Recent boards"}</SectionLabel>
                  {boardCandidates.map((board, index) => (
                    <ComboboxItem
                      key={board.key}
                      hideIndicator
                      index={actions.length + index}
                      value={`${BOARD_PREFIX}${board.key}`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <OrganizingIcon icon={board.icon} kind="board" />
                        <span className="min-w-0 truncate">{board.name}</span>
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                          {board.key}
                        </span>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          Open board
                        </span>
                      </span>
                    </ComboboxItem>
                  ))}
                </>
              ) : null}
              <SectionLabel>{linkedKey === null ? "Link to a ticket" : "Tickets"}</SectionLabel>
              {ticketCandidates.length === 0 ? (
                <p className="px-2 pb-2 text-xs text-muted-foreground">
                  {query.trim()
                    ? "No matching tickets."
                    : "No tickets yet. Create them on a board."}
                </p>
              ) : (
                ticketCandidates.map((candidate, index) => (
                  <ComboboxItem
                    key={candidate.id}
                    hideIndicator
                    index={actions.length + boardCandidates.length + index}
                    value={candidate.id}
                  >
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {candidate.label}
                      </span>
                      <span className="min-w-0 truncate">{candidate.title}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {candidate.label === linkedKey ? "Linked" : candidate.boardName}
                      </span>
                    </span>
                  </ComboboxItem>
                ))
              )}
            </>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
