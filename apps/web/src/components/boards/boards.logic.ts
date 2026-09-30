import type {
  Board,
  BoardColumnType,
  BoardsSnapshot,
  Ticket,
  TicketEvent,
} from "@t3tools/contracts";

export function ticketKey(board: Pick<Board, "key">, ticket: Pick<Ticket, "number">): string {
  return `${board.key}-${ticket.number}`;
}

/** Indexes for resolving columns, boards, and tickets across the snapshot. */
export interface BoardsIndex {
  readonly boardById: ReadonlyMap<string, Board>;
  readonly boardByKey: ReadonlyMap<string, Board>;
  readonly ticketById: ReadonlyMap<string, Ticket>;
  readonly columnTypeById: ReadonlyMap<string, BoardColumnType>;
}

export function indexBoards(snapshot: BoardsSnapshot): BoardsIndex {
  const columnTypeById = new Map<string, BoardColumnType>();
  for (const board of snapshot.boards) {
    for (const column of board.columns) columnTypeById.set(column.id, column.type);
  }
  return {
    boardById: new Map(snapshot.boards.map((board) => [board.id, board])),
    boardByKey: new Map(snapshot.boards.map((board) => [board.key, board])),
    ticketById: new Map(snapshot.tickets.map((ticket) => [ticket.id, ticket])),
    columnTypeById,
  };
}

/** Required tickets that are not done yet; a ticket with any is blocked. */
export function ticketBlockers(ticket: Ticket, index: BoardsIndex): Ticket[] {
  return ticket.requires.flatMap((id) => {
    const required = index.ticketById.get(id);
    if (!required) return [];
    return index.columnTypeById.get(required.columnId) === "done" ? [] : [required];
  });
}

export function ticketLabel(ticket: Ticket, index: BoardsIndex): string {
  const board = index.boardById.get(ticket.boardId);
  return board ? ticketKey(board, ticket) : `#${ticket.number}`;
}

/** What a linked chat is waiting on, from the thread shell's attention flags. */
export interface LinkedThreadAttention {
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
}

export type TicketAttention =
  | { readonly kind: "attention"; readonly reason: string }
  | { readonly kind: "approval"; readonly reason: string }
  | { readonly kind: "input"; readonly reason: string };

/**
 * Why a ticket needs Kreshel, or null. Only human-required states count: the
 * attention column (with its reason) and linked chats waiting on an approval or
 * an answer. Review is ordinary work and does not count.
 */
export function ticketAttention(
  ticket: Ticket,
  columnType: BoardColumnType | undefined,
  linkedThreads: ReadonlyArray<LinkedThreadAttention>,
): TicketAttention | null {
  if (ticket.archivedAt !== null || columnType === "done" || columnType === "canceled") {
    return null;
  }
  if (linkedThreads.some((thread) => thread.hasPendingApprovals)) {
    return { kind: "approval", reason: "A chat is waiting for your approval" };
  }
  if (linkedThreads.some((thread) => thread.hasPendingUserInput)) {
    return { kind: "input", reason: "A chat asked you a question" };
  }
  if (columnType === "attention") {
    return { kind: "attention", reason: ticket.attentionReason ?? "Needs you" };
  }
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

const STARTED_COLUMN_TYPES: ReadonlySet<BoardColumnType> = new Set(["active", "review", "done"]);

/**
 * Whether moving a ticket starts it: from a not-started column into active,
 * review, or done. A blocked ticket needs a person to confirm that move; the
 * server refuses it otherwise.
 */
export function moveStartsTicket(from: BoardColumnType | undefined, to: BoardColumnType): boolean {
  return STARTED_COLUMN_TYPES.has(to) && (from === undefined || !STARTED_COLUMN_TYPES.has(from));
}

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
 * Tickets that entered an attention column since `previous` (ids). The first
 * snapshot (previous null) only sets the baseline, so opening the app does
 * not replay every ticket already waiting.
 */
export function ticketsNewlyInAttention(
  previous: ReadonlySet<string> | null,
  snapshot: BoardsSnapshot,
): { readonly current: ReadonlySet<string>; readonly added: ReadonlyArray<Ticket> } {
  const index = indexBoards(snapshot);
  const waiting = snapshot.tickets.filter(
    (ticket) =>
      ticket.archivedAt === null &&
      index.boardById.get(ticket.boardId)?.archivedAt === null &&
      index.columnTypeById.get(ticket.columnId) === "attention",
  );
  const current = new Set(waiting.map((ticket) => ticket.id));
  if (previous === null) return { current, added: [] };
  return { current, added: waiting.filter((ticket) => !previous.has(ticket.id)) };
}
