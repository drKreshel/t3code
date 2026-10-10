import { BoardKey } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isBoardKey = Schema.is(BoardKey);

export type BoardRouteLinkTarget =
  | { readonly kind: "boards" }
  | { readonly kind: "board"; readonly boardKey: string }
  | {
      readonly kind: "ticket";
      readonly boardKey: string;
      readonly ticketNumber: number;
    };

/** Recognizes only T3's canonical board routes, before absolute paths become file links. */
export function parseBoardRouteLinkHref(href: string): BoardRouteLinkTarget | null {
  if (href === "/boards" || href === "/boards/") return { kind: "boards" };
  const match = /^\/boards\/([^/]+)(?:\/([1-9][0-9]*))?\/?$/.exec(href);
  if (!match) return null;
  const boardKey = match[1];
  if (!boardKey || !isBoardKey(boardKey)) return null;
  const writtenNumber = match[2];
  if (writtenNumber === undefined) return { kind: "board", boardKey };
  const ticketNumber = Number(writtenNumber);
  return Number.isSafeInteger(ticketNumber) ? { kind: "ticket", boardKey, ticketNumber } : null;
}

export function boardRouteLinkHref(target: BoardRouteLinkTarget): string {
  if (target.kind === "boards") return "/boards";
  if (target.kind === "board") return `/boards/${target.boardKey}`;
  return `/boards/${target.boardKey}/${target.ticketNumber}`;
}

export function boardRouteLinkLabel(target: BoardRouteLinkTarget): string {
  if (target.kind === "boards") return "Boards";
  if (target.kind === "board") return target.boardKey;
  return `${target.boardKey}-${target.ticketNumber}`;
}

/** An internal board link whose label cannot break its Markdown syntax. */
export function formatBoardRouteLink(target: BoardRouteLinkTarget, label: string): string {
  const cleaned = label
    .replace(/[[\]\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `[${cleaned || boardRouteLinkLabel(target)}](${boardRouteLinkHref(target)})`;
}
