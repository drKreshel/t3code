import type { BoardRouteLinkTarget } from "@t3tools/shared/forkBoardLinks";
import { formatBoardRouteLink } from "@t3tools/shared/forkBoardLinks";
import { Link } from "@tanstack/react-router";
import { SquareKanbanIcon, TicketIcon } from "lucide-react";

/** A `/boards/...` Markdown link that stays inside the app instead of opening as a file. */
export function MarkdownBoardRouteLink(props: {
  readonly target: BoardRouteLinkTarget;
  readonly label: string;
}) {
  const content = (
    <>
      <span
        className="ms-[0.25em] me-[0.2em] inline-flex size-[14px] [vertical-align:-0.125em]"
        aria-hidden
      >
        {props.target.kind === "ticket" ? (
          <TicketIcon className="block size-full shrink-0" />
        ) : (
          <SquareKanbanIcon className="block size-full shrink-0" />
        )}
      </span>
      {props.label}
    </>
  );
  const shared = {
    title: `Open ${props.target.kind === "ticket" ? "ticket" : "board"}`,
    "data-markdown-copy": formatBoardRouteLink(props.target, props.label),
  } as const;
  if (props.target.kind === "ticket") {
    return (
      <Link
        {...shared}
        to="/boards/$boardKey/$ticketNumber"
        params={{
          boardKey: props.target.boardKey,
          ticketNumber: String(props.target.ticketNumber),
        }}
      >
        {content}
      </Link>
    );
  }
  if (props.target.kind === "board") {
    return (
      <Link {...shared} to="/boards/$boardKey" params={{ boardKey: props.target.boardKey }}>
        {content}
      </Link>
    );
  }
  return (
    <Link {...shared} to="/boards">
      {content}
    </Link>
  );
}
