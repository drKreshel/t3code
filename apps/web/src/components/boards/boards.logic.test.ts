import type { Board, BoardsSnapshot, Ticket } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeTicketEvent,
  indexBoards,
  positionBetween,
  recentBoardsByActivity,
  suggestBoardKey,
  ticketAttention,
  ticketBlockers,
  ticketsByColumn,
  ticketsNewlyFlagged,
} from "./boards.logic";

const board: Board = {
  id: "b1",
  key: "WEB",
  name: "Web",
  defaultProjectKey: null,
  position: 1,
  columns: [
    { id: "todo", name: "Todo", color: null, position: 1 },
    { id: "review", name: "Review", color: "violet", position: 2 },
    { id: "done", name: "Done", color: "green", position: 3 },
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
  status: "open",
  flag: null,
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
        ticket("done-one", { status: "done" }),
        // Sitting in the Done column means nothing; the status decides.
        ticket("canceled-one", { columnId: "done", status: "canceled" }),
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
  const flag = (level: "warning" | "error", reason: string) => ({
    level,
    reason,
    by: "automation:a",
    at: "2026-09-30T00:00:00.000Z",
  });

  it("shows flags and waiting chats wherever the ticket sits, red before yellow", () => {
    expect(ticketAttention(ticket("t", { columnId: "review" }), [])).toBeNull();
    expect(ticketAttention(ticket("t", { flag: flag("warning", "Which API?") }), [])).toEqual({
      level: "warning",
      kind: "flag",
      reason: "Which API?",
    });
    expect(ticketAttention(ticket("t"), [{ hasPendingUserInput: true }])?.kind).toBe("input");
    expect(
      ticketAttention(ticket("t", { flag: flag("warning", "Stuck") }), [
        { sessionError: "Usage limit reached" },
      ]),
    ).toEqual({ level: "error", kind: "session", reason: "Usage limit reached" });
    expect(
      ticketAttention(ticket("t", { flag: flag("error", "Run failed") }), [
        { hasPendingApprovals: true },
      ])?.reason,
    ).toBe("Run failed");
  });

  it("ignores archived tickets", () => {
    expect(
      ticketAttention(ticket("t", { archivedAt: "x", flag: flag("error", "Run failed") }), []),
    ).toBeNull();
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

describe("ticketsNewlyFlagged", () => {
  const flagged = (id: string, at: string) =>
    ticket(id, { flag: { level: "warning", reason: "Help", by: "thread:x", at } });

  it("sets a baseline first, then reports new and re-raised flags", () => {
    const first = ticketsNewlyFlagged(null, snapshot([flagged("old", "t1"), ticket("calm")]));
    expect(first.added).toEqual([]);
    const next = ticketsNewlyFlagged(
      first.current,
      snapshot(
        [flagged("old", "t1"), flagged("calm", "t2"), flagged("archived", "t3")].map((entry) =>
          entry.id === "archived" ? { ...entry, archivedAt: "x" } : entry,
        ),
      ),
    );
    expect(next.added.map((t) => t.id)).toEqual(["calm"]);
    const raisedAgain = ticketsNewlyFlagged(next.current, snapshot([flagged("old", "t9")]));
    expect(raisedAgain.added.map((t) => t.id)).toEqual(["old"]);
  });
});

describe("recentBoardsByActivity", () => {
  it("orders live boards by their newest ticket change", () => {
    const other: Board = { ...board, id: "b2", key: "API", updatedAt: "2026-09-02" };
    const archived: Board = { ...board, id: "b3", key: "OLD", archivedAt: "x" };
    const state: BoardsSnapshot = {
      boards: [{ ...board, updatedAt: "2026-09-01" }, other, archived],
      tickets: [ticket("t", { boardId: "b1", updatedAt: "2026-09-05" })],
    };
    expect(recentBoardsByActivity(state, 5).map((entry) => entry.key)).toEqual(["WEB", "API"]);
    expect(recentBoardsByActivity(state, 1).map((entry) => entry.key)).toEqual(["WEB"]);
  });
});
