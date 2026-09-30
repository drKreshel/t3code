import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { SquareKanbanIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useBoards, useBoardsDispatch, useThreadTicketKey } from "../../state/boards";
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

interface Candidate {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly boardName: string;
}

/**
 * The chat header's ticket: shows the linked ticket's key and links, changes,
 * or unlinks it. Works for drafts too, since a draft's thread id is its
 * future server thread's.
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
  // Narrows the list to one board; null lists every board.
  const [boardScope, setBoardScope] = useState<string | null>(null);
  const boards = useBoards();
  const dispatch = useBoardsDispatch();
  const navigate = useNavigate();

  // Boards with the latest ticket activity, for the quick scope row.
  const recentBoards = useMemo(() => {
    if (!open || boards.status !== "ready") return [];
    return recentBoardsByActivity(boards.snapshot, RECENT_BOARD_COUNT);
  }, [boards, open]);

  // Built only while the picker is open; the closed chip reads one string.
  const candidates = useMemo((): Candidate[] => {
    if (!open || boards.status !== "ready") return [];
    const { snapshot } = boards;
    const liveBoards = snapshot.boards
      .filter(
        (board) => board.archivedAt === null && (boardScope === null || board.id === boardScope),
      )
      .toSorted((a, b) => a.position - b.position);
    const needle = query.trim().toLowerCase();
    return liveBoards.flatMap((board) => {
      // A query naming the board lists all of its tickets.
      const boardMatches =
        needle !== "" &&
        (board.name.toLowerCase().includes(needle) || board.key.toLowerCase().includes(needle));
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
            boardMatches ||
            candidate.label.toLowerCase().includes(needle) ||
            candidate.title.toLowerCase().includes(needle),
        );
    });
  }, [boardScope, boards, open, query]);

  const actions = linkedKey === null ? [] : [OPEN, UNLINK];
  const keys = [...actions, ...candidates.map((candidate) => candidate.id)];

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
    else void dispatch({ type: "thread.link", threadKey, ticketId: key });
  };

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
        if (!next) {
          setQuery("");
          setBoardScope(null);
        }
      }}
    >
      <ComboboxTrigger render={trigger} />
      <ComboboxPopup align="start" side="bottom" className="w-80">
        <ComboboxSearchInput
          aria-label="Search tickets"
          placeholder="Search tickets or boards"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {recentBoards.length > 1 ? (
          <div
            role="group"
            aria-label="Boards"
            className="flex flex-wrap gap-1 border-b px-2 pb-2"
            // Keep focus in the search input so typing and arrows keep working.
            onMouseDown={(event) => event.preventDefault()}
          >
            <Button
              size="xs"
              variant={boardScope === null ? "secondary" : "ghost"}
              aria-pressed={boardScope === null}
              onClick={() => setBoardScope(null)}
            >
              All
            </Button>
            {recentBoards.map((board) => (
              <Button
                key={board.id}
                size="xs"
                variant={boardScope === board.id ? "secondary" : "ghost"}
                aria-pressed={boardScope === board.id}
                aria-label={`Only ${board.name}`}
                onClick={() => setBoardScope(boardScope === board.id ? null : board.id)}
              >
                {board.key}
              </Button>
            ))}
          </div>
        ) : null}
        <ComboboxList className="max-h-80">
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
              {boards.status === "loading" ? "Loading tickets…" : "Boards are unavailable."}
            </p>
          ) : candidates.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              {query.trim() ? "No matching tickets." : "No tickets yet. Create them on a board."}
            </p>
          ) : (
            candidates.map((candidate, index) => (
              <ComboboxItem
                key={candidate.id}
                hideIndicator
                index={actions.length + index}
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
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
