import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { useBoards, useThreadTicketKey } from "../../state/boards";
import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";

export function ThreadBoardBreadcrumb({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ticketKey = useThreadTicketKey(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
  const boards = useBoards();
  const boardKey = ticketKey?.slice(0, ticketKey.lastIndexOf("-"));
  const ticketNumber = ticketKey?.slice(ticketKey.lastIndexOf("-") + 1);
  const board =
    boards.status === "ready"
      ? boards.snapshot.boards.find((candidate) => candidate.key === boardKey)
      : undefined;
  const ticket =
    boards.status === "ready" && board
      ? boards.snapshot.tickets.find(
          (candidate) =>
            candidate.boardId === board.id && candidate.number === Number(ticketNumber),
        )
      : undefined;
  if (!board || !ticket || !ticketKey || !ticketNumber) return null;
  return (
    <>
      <WorkspaceBreadcrumbItem className="shrink">
        <Link
          to="/boards/$boardKey"
          params={{ boardKey: board.key }}
          aria-label={`Board ${board.name}`}
        >
          <WorkspaceBreadcrumbText className="max-w-40">{board.name}</WorkspaceBreadcrumbText>
        </Link>
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator>
        <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
      </WorkspaceBreadcrumbSeparator>
      <WorkspaceBreadcrumbItem>
        <Link
          to="/boards/$boardKey/$ticketNumber"
          params={{ boardKey: board.key, ticketNumber }}
          aria-label={`Ticket ${ticketKey}: ${ticket.title}`}
          title={ticket.title}
        >
          <WorkspaceBreadcrumbText>{ticketKey}</WorkspaceBreadcrumbText>
        </Link>
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator>
        <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
      </WorkspaceBreadcrumbSeparator>
    </>
  );
}
