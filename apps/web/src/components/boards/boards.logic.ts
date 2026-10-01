import type { Board, BoardsSnapshot, Ticket, TicketEvent } from "@t3tools/contracts";

export function ticketKey(board: Pick<Board, "key">, ticket: Pick<Ticket, "number">): string {
  return `${board.key}-${ticket.number}`;
}

/** Indexes for resolving columns, boards, and tickets across the snapshot. */
export interface BoardsIndex {
  readonly boardById: ReadonlyMap<string, Board>;
  readonly boardByKey: ReadonlyMap<string, Board>;
  readonly ticketById: ReadonlyMap<string, Ticket>;
}

export function indexBoards(snapshot: BoardsSnapshot): BoardsIndex {
  return {
    boardById: new Map(snapshot.boards.map((board) => [board.id, board])),
    boardByKey: new Map(snapshot.boards.map((board) => [board.key, board])),
    ticketById: new Map(snapshot.tickets.map((ticket) => [ticket.id, ticket])),
  };
}

/** A required ticket and the column it sits in; T3 judges nothing from it. */
export interface TicketRequirement {
  readonly ticket: Ticket;
  readonly label: string;
  readonly columnName: string;
  readonly columnColor: string | null;
}

/** The tickets this one requires (that still exist), with where each sits. */
export function ticketRequirements(ticket: Ticket, index: BoardsIndex): TicketRequirement[] {
  return ticket.requires.flatMap((id) => {
    const required = index.ticketById.get(id);
    if (!required) return [];
    const board = index.boardById.get(required.boardId);
    const column = board?.columns.find((candidate) => candidate.id === required.columnId);
    return [
      {
        ticket: required,
        label: board ? ticketKey(board, required) : `#${required.number}`,
        columnName: column?.name ?? "",
        columnColor: column?.color ?? null,
      },
    ];
  });
}

export function ticketLabel(ticket: Ticket, index: BoardsIndex): string {
  const board = index.boardById.get(ticket.boardId);
  return board ? ticketKey(board, ticket) : `#${ticket.number}`;
}

/** What a linked chat is waiting on, from its thread shell. */
export interface LinkedThreadAttention {
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  /** Set when the chat's session stopped with an error (limits, model down, crash). */
  readonly sessionError?: string | null;
}

/**
 * Why a ticket waits on Kreshel, shown wherever it sits. `error` (red) beats
 * `warning` (yellow). Stored flags come from agents and automations; the rest
 * is read live from the ticket's chats and clears when they recover.
 */
export interface TicketAttention {
  readonly level: "warning" | "error";
  readonly kind: "flag" | "approval" | "input" | "session";
  readonly reason: string;
}

export function ticketAttention(
  ticket: Ticket,
  linkedThreads: ReadonlyArray<LinkedThreadAttention>,
): TicketAttention | null {
  if (ticket.archivedAt !== null) return null;
  const sessionError = linkedThreads.find((thread) => thread.sessionError)?.sessionError;
  if (ticket.flag?.level === "error") {
    return { level: "error", kind: "flag", reason: ticket.flag.reason };
  }
  if (sessionError) return { level: "error", kind: "session", reason: sessionError };
  if (linkedThreads.some((thread) => thread.hasPendingApprovals)) {
    return { level: "warning", kind: "approval", reason: "A chat is waiting for your approval" };
  }
  if (linkedThreads.some((thread) => thread.hasPendingUserInput)) {
    return { level: "warning", kind: "input", reason: "A chat asked you a question" };
  }
  if (ticket.flag) return { level: "warning", kind: "flag", reason: ticket.flag.reason };
  return null;
}

/** Tickets of a board by column, in position order, archived ones excluded. */
export function ticketsByColumn(
  board: Board,
  tickets: ReadonlyArray<Ticket>,
): Map<string, Ticket[]> {
  const byColumn = new Map<string, Ticket[]>(board.columns.map((column) => [column.id, []]));
  for (const ticket of tickets) {
    if (ticket.boardId !== board.id || ticket.archivedAt !== null) continue;
    byColumn.get(ticket.columnId)?.push(ticket);
  }
  for (const list of byColumn.values()) list.sort((a, b) => a.position - b.position);
  return byColumn;
}

/**
 * A position that sorts between two neighbours. Positions are floats, so a
 * move writes one row instead of renumbering the column.
 */
export function positionBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 1;
  if (before === undefined) return after! - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

/** A board key suggestion from its name: "Web app" → "WA", "Payments" → "PAY". */
export function suggestBoardKey(name: string, taken: ReadonlySet<string>): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const initials = words.map((word) => word[0]).join("");
  const base =
    (words.length > 1 ? initials : (words[0] ?? "")).replace(/^[0-9]+/, "").slice(0, 5) || "B";
  const padded = base.length >= 2 ? base : `${base}${(words[0] ?? "X").slice(1, 3) || "X"}`;
  const candidate = padded.slice(0, 5).padEnd(2, "X");
  if (!taken.has(candidate)) return candidate;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const next = `${candidate.slice(0, 5 - String(suffix).length)}${suffix}`;
    if (!taken.has(next)) return next;
  }
  return candidate;
}

export const BOARD_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,4}$/;

/** One line for a timeline event, from its kind and payload. */
export function describeTicketEvent(event: Pick<TicketEvent, "kind" | "payload">): string {
  const text = (key: string) => {
    const value = event.payload[key];
    return typeof value === "string" ? value : "";
  };
  switch (event.kind) {
    case "created":
      return `Created in ${text("column")}`;
    case "moved":
      return `Moved from ${text("from")} to ${text("to")}${text("reason") ? `: ${text("reason")}` : ""}`;
    case "updated": {
      const fields = event.payload.fields;
      const list = Array.isArray(fields) ? fields.filter((field) => typeof field === "string") : [];
      if (list.length === 1 && list[0] === "priority" && text("priority")) {
        return `Set priority to ${text("priority")}`;
      }
      return `Changed ${list.join(", ") || "details"}`;
    }
    case "criterion.checked":
      return `Checked "${text("text")}"`;
    case "criterion.unchecked":
      return `Unchecked "${text("text")}"`;
    case "requirement.added":
      return `Now requires ${text("ticket")}`;
    case "requirement.removed":
      return `No longer requires ${text("ticket")}`;
    case "blocked":
      return `Blocked again: ${text("by")} was reopened`;
    case "unblocked":
      return `Unblocked: ${text("by")} is done`;
    case "status":
      return text("to") === "open" ? "Reopened" : `Closed as ${text("to")}`;
    case "flagged":
      return `Flagged: ${text("reason")}`;
    case "flag.resolved":
      return "Resolved the flag";
    case "thread.linked":
      return "Linked a chat";
    case "thread.unlinked":
      return "Unlinked a chat";
    case "archived":
      return "Archived";
    case "unarchived":
      return "Restored";
    default:
      return event.kind;
  }
}

/**
 * Tickets whose stored flag was raised since `previous` (ticket id → flag
 * time). The first snapshot (previous null) only sets the baseline, so opening
 * the app does not replay every ticket already flagged.
 */
export function ticketsNewlyFlagged(
  previous: ReadonlyMap<string, string> | null,
  snapshot: BoardsSnapshot,
): { readonly current: ReadonlyMap<string, string>; readonly added: ReadonlyArray<Ticket> } {
  const index = indexBoards(snapshot);
  const flagged = snapshot.tickets.filter(
    (ticket) =>
      ticket.flag !== null &&
      ticket.archivedAt === null &&
      index.boardById.get(ticket.boardId)?.archivedAt === null,
  );
  const current = new Map(flagged.map((ticket) => [ticket.id, ticket.flag!.at]));
  if (previous === null) return { current, added: [] };
  return {
    current,
    added: flagged.filter((ticket) => previous.get(ticket.id) !== ticket.flag!.at),
  };
}

/**
 * Live boards by latest activity (the newest ticket change, else the board's
 * own), most recent first. Stands in for "recently used" without tracking it.
 */
export function recentBoardsByActivity(snapshot: BoardsSnapshot, limit: number): Board[] {
  const lastActivity = new Map<string, string>();
  for (const board of snapshot.boards) lastActivity.set(board.id, board.updatedAt);
  for (const ticket of snapshot.tickets) {
    const current = lastActivity.get(ticket.boardId);
    if (current !== undefined && ticket.updatedAt > current) {
      lastActivity.set(ticket.boardId, ticket.updatedAt);
    }
  }
  return snapshot.boards
    .filter((board) => board.archivedAt === null)
    .toSorted((a, b) => (lastActivity.get(b.id) ?? "").localeCompare(lastActivity.get(a.id) ?? ""))
    .slice(0, limit);
}
