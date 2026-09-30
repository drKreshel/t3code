/**
 * Pure lookups for the boards MCP tools: agents name things the way people
 * do (`WEB-12`, "Testing", "the second criterion"), and these turn that into
 * ids or a message saying what exists instead.
 */
import {
  type Board,
  type BoardColumn,
  type BoardsSnapshot,
  type Ticket,
  type TicketCriterion,
} from "@t3tools/contracts";

export type Lookup<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

const found = <A>(value: A): Lookup<A> => ({ ok: true, value });
const missing = <A>(message: string): Lookup<A> => ({ ok: false, message });

export function ticketKeyOf(board: Pick<Board, "key">, ticket: Pick<Ticket, "number">): string {
  return `${board.key}-${ticket.number}`;
}

export function findBoard(snapshot: BoardsSnapshot, key: string): Lookup<Board> {
  const wanted = key.trim().toUpperCase();
  const board = snapshot.boards.find((candidate) => candidate.key === wanted);
  if (board) return found(board);
  const keys = snapshot.boards.map((candidate) => candidate.key);
  return missing(
    keys.length === 0
      ? "There are no boards yet. Create one with create_board."
      : `No board has the key ${wanted}. Boards: ${keys.join(", ")}.`,
  );
}

/** A ticket by key (`WEB-12`) or id. */
export function findTicket(snapshot: BoardsSnapshot, ref: string): Lookup<Ticket> {
  const trimmed = ref.trim();
  const byId = snapshot.tickets.find((ticket) => ticket.id === trimmed);
  if (byId) return found(byId);
  const match = /^([A-Za-z][A-Za-z0-9]{1,4})-(\d+)$/.exec(trimmed);
  if (!match) return missing(`"${trimmed}" is not a ticket key like WEB-12.`);
  const board = findBoard(snapshot, match[1]!);
  if (!board.ok) return board;
  const number = Number(match[2]);
  const ticket = snapshot.tickets.find(
    (candidate) => candidate.boardId === board.value.id && candidate.number === number,
  );
  return ticket ? found(ticket) : missing(`There is no ticket ${board.value.key}-${number}.`);
}

/** A column by name (case-insensitive). */
export function findColumn(board: Board, ref: string): Lookup<BoardColumn> {
  const wanted = ref.trim().toLowerCase();
  const columns = board.columns.toSorted((a, b) => a.position - b.position);
  const byName = columns.find((column) => column.name.toLowerCase() === wanted);
  if (byName) return found(byName);
  const names = columns.map((column) => column.name).join(", ");
  return missing(`Board ${board.key} has no column "${ref.trim()}". Columns: ${names}.`);
}

/** A criterion by id, 1-based number, or exact text (case-insensitive). */
export function findCriterion(ticket: Ticket, ref: string): Lookup<TicketCriterion> {
  const criteria = ticket.criteria.toSorted((a, b) => a.position - b.position);
  const trimmed = ref.trim();
  const byId = criteria.find((criterion) => criterion.id === trimmed);
  if (byId) return found(byId);
  if (/^\d+$/.test(trimmed)) {
    const byNumber = criteria[Number(trimmed) - 1];
    if (byNumber) return found(byNumber);
  }
  const byText = criteria.find(
    (criterion) => criterion.text.toLowerCase() === trimmed.toLowerCase(),
  );
  if (byText) return found(byText);
  return missing(
    `The ticket has no criterion "${trimmed}". Pass its number (1-${criteria.length}), id, or exact text.`,
  );
}

/** Tickets matching optional board, column, and text filters, skipping archived ones. */
export function filterTickets(
  snapshot: BoardsSnapshot,
  filter: {
    readonly board?: Board | undefined;
    readonly column?: BoardColumn | undefined;
    readonly query?: string | undefined;
    readonly includeArchived?: boolean | undefined;
  },
): Ticket[] {
  const query = filter.query?.trim().toLowerCase() ?? "";
  return snapshot.tickets.filter(
    (ticket) =>
      (filter.includeArchived === true || ticket.archivedAt === null) &&
      (filter.board === undefined || ticket.boardId === filter.board.id) &&
      (filter.column === undefined || ticket.columnId === filter.column.id) &&
      (query === "" ||
        ticket.title.toLowerCase().includes(query) ||
        ticket.description.toLowerCase().includes(query)),
  );
}
