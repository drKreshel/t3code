import type { Board, BoardsSnapshot, Ticket } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeTicketEvent,
  indexBoards,
  moveStartsTicket,
  positionBetween,
  suggestBoardKey,
  ticketAttention,
  ticketBlockers,
  ticketsByColumn,
  ticketsNewlyInAttention,
} from "./boards.logic";

const board: Board = {
  id: "b1",
  key: "WEB",
  name: "Web",
  defaultProjectKey: null,
  position: 1,
  columns: [
    { id: "todo", name: "Todo", type: "todo", position: 1 },
    { id: "attention", name: "Needs you", type: "attention", position: 2 },
    { id: "done", name: "Done", type: "done", position: 3 },
  ],
  createdAt: "",
  updatedAt: "",
  archivedAt: null,
};

const ticket = (id: string, overrides: Partial<Ticket> = {}): Ticket => ({
  id,
  boardId: "b1",
  number: 1,
  title: id,
  description: "",
  columnId: "todo",
  priority: "none",
  projectKey: null,
  position: 1,
  attentionReason: null,
  requires: [],
  criteria: [],
  threadKeys: [],
  createdAt: "",
  updatedAt: "",
  archivedAt: null,
  ...overrides,
});

const snapshot = (tickets: Ticket[]): BoardsSnapshot => ({ boards: [board], tickets });

describe("ticketBlockers", () => {
  it("lists required tickets that are not done", () => {
    const index = indexBoards(
      snapshot([
        ticket("done-one", { columnId: "done" }),
        ticket("open-one"),
        ticket("t", { requires: ["done-one", "open-one"] }),
      ]),
    );
    expect(ticketBlockers(index.ticketById.get("t")!, index).map((t) => t.id)).toEqual([
      "open-one",
    ]);
  });
});

describe("ticketAttention", () => {
  it("needs you only for questions, approvals, and the attention column", () => {
    expect(ticketAttention(ticket("t"), "todo", [])).toBeNull();
    expect(ticketAttention(ticket("t"), "review", [])).toBeNull();
    expect(
      ticketAttention(ticket("t", { attentionReason: "Which API?" }), "attention", []),
    ).toEqual({ kind: "attention", reason: "Which API?" });
    expect(ticketAttention(ticket("t"), "active", [{ hasPendingUserInput: true }])?.kind).toBe(
      "input",
    );
    expect(ticketAttention(ticket("t"), "active", [{ hasPendingApprovals: true }])?.kind).toBe(
      "approval",
    );
  });

  it("ignores finished and archived tickets", () => {
    expect(ticketAttention(ticket("t"), "done", [{ hasPendingUserInput: true }])).toBeNull();
    expect(ticketAttention(ticket("t", { archivedAt: "2026-09-29" }), "attention", [])).toBeNull();
  });
});

describe("ticketsByColumn", () => {
  it("groups a board's live tickets by column in position order", () => {
    const grouped = ticketsByColumn(board, [
      ticket("b", { position: 2 }),
      ticket("a", { position: 1 }),
      ticket("archived", { archivedAt: "x" }),
      ticket("other-board", { boardId: "b2" }),
    ]);
    expect(grouped.get("todo")!.map((t) => t.id)).toEqual(["a", "b"]);
    expect(grouped.get("done")).toEqual([]);
  });
});

describe("positionBetween", () => {
  it("sorts between neighbours and at either end", () => {
    expect(positionBetween(1, 2)).toBe(1.5);
    expect(positionBetween(undefined, 1)).toBe(0);
    expect(positionBetween(3, undefined)).toBe(4);
    expect(positionBetween(undefined, undefined)).toBe(1);
  });
});

describe("suggestBoardKey", () => {
  it("derives a valid key and avoids taken ones", () => {
    expect(suggestBoardKey("Web app", new Set())).toBe("WA");
    expect(suggestBoardKey("Payments", new Set())).toBe("PAYME");
    expect(suggestBoardKey("Web app", new Set(["WA"]))).toBe("WA2");
    expect(suggestBoardKey("42 things", new Set())).toMatch(/^[A-Z][A-Z0-9]{1,4}$/);
  });
});

describe("moveStartsTicket", () => {
  it("is true only when leaving a not-started column for a started one", () => {
    expect(moveStartsTicket("todo", "active")).toBe(true);
    expect(moveStartsTicket("backlog", "done")).toBe(true);
    expect(moveStartsTicket("active", "review")).toBe(false);
    expect(moveStartsTicket("todo", "attention")).toBe(false);
  });
});

describe("describeTicketEvent", () => {
  it("reads payloads and falls back to the kind", () => {
    expect(
      describeTicketEvent({
        kind: "moved",
        payload: { from: "Todo", to: "Needs you", reason: "Which API?" },
      }),
    ).toBe("Moved from Todo to Needs you: Which API?");
    expect(
      describeTicketEvent({ kind: "updated", payload: { fields: ["priority"], priority: "high" } }),
    ).toBe("Set priority to high");
    expect(
      describeTicketEvent({ kind: "updated", payload: { fields: ["title", "description"] } }),
    ).toBe("Changed title, description");
    expect(describeTicketEvent({ kind: "something.new", payload: {} })).toBe("something.new");
  });
});

describe("ticketsNewlyInAttention", () => {
  it("sets a baseline first, then reports only tickets that just arrived", () => {
    const first = ticketsNewlyInAttention(
      null,
      snapshot([ticket("waiting", { columnId: "attention" }), ticket("todo")]),
    );
    expect(first.added).toEqual([]);
    const next = ticketsNewlyInAttention(
      first.current,
      snapshot([
        ticket("waiting", { columnId: "attention" }),
        ticket("todo", { columnId: "attention" }),
        ticket("archived", { columnId: "attention", archivedAt: "x" }),
      ]),
    );
    expect(next.added.map((t) => t.id)).toEqual(["todo"]);
  });
});
