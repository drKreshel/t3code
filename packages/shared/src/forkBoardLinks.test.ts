import { describe, expect, it } from "vite-plus/test";

import {
  boardRouteLinkHref,
  formatBoardRouteLink,
  parseBoardRouteLinkHref,
} from "./forkBoardLinks.ts";

describe("board route links", () => {
  it("recognizes the boards index, a board, and a ticket", () => {
    expect(parseBoardRouteLinkHref("/boards")).toEqual({ kind: "boards" });
    expect(parseBoardRouteLinkHref("/boards/SALON")).toEqual({
      kind: "board",
      boardKey: "SALON",
    });
    expect(parseBoardRouteLinkHref("/boards/SALON/36")).toEqual({
      kind: "ticket",
      boardKey: "SALON",
      ticketNumber: 36,
    });
  });

  it("rejects lookalike filesystem paths and invalid keys or ticket numbers", () => {
    for (const href of [
      "/boards/SALON/36/file.ts",
      "/boards/salon",
      "/boards/TOO-LONG",
      "/boards/SALON/0",
      "/boards/SALON/01",
      "/tmp/boards/SALON/36",
    ]) {
      expect(parseBoardRouteLinkHref(href)).toBeNull();
    }
  });

  it("formats canonical paths and Markdown-safe labels", () => {
    const target = { kind: "ticket", boardKey: "SALON", ticketNumber: 36 } as const;
    expect(boardRouteLinkHref(target)).toBe("/boards/SALON/36");
    expect(formatBoardRouteLink(target, "Ship [email] \\ now")).toBe(
      "[Ship email now](/boards/SALON/36)",
    );
  });
});
