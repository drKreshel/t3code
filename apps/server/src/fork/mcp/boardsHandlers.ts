import {
  type Board,
  BoardsCommandError,
  type TicketWorkspace,
  type BoardsCommand,
  type BoardsSnapshot,
  ProjectId,
  ThreadId,
  type Ticket,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { BoardsService } from "../boards/BoardsService.ts";
import { unavailableBoards } from "../rpcHandlers.ts";
import { TicketWorkspaces } from "../workspaces/TicketWorkspaces.ts";
import {
  filterTickets,
  findBoard,
  findColumn,
  findCriterion,
  findTicket,
  type Lookup,
  ticketKeyOf,
} from "./boardsToolLogic.ts";
import {
  type BoardSummary,
  BoardsToolkit,
  type TicketDetailResult,
  type TicketSummary,
} from "./boardsTools.ts";

const notFound = (message: string) => new BoardsCommandError({ code: "not-found", message });
const storage = (message: string) => () => new BoardsCommandError({ code: "storage", message });

const unwrap = <A>(lookup: Lookup<A>): Effect.Effect<A, BoardsCommandError> =>
  lookup.ok ? Effect.succeed(lookup.value) : Effect.fail(notFound(lookup.message));

const ticketPath = (board: Board, ticket: Ticket) => `/boards/${board.key}/${ticket.number}`;

/** Required tickets that are not in a done column. */
function blockersOf(snapshot: BoardsSnapshot, ticket: Ticket): Ticket[] {
  return ticket.requires.flatMap((id) => {
    const required = snapshot.tickets.find((candidate) => candidate.id === id);
    return required && required.status !== "done" ? [required] : [];
  });
}

function labelOf(snapshot: BoardsSnapshot, ticket: Ticket): string {
  const board = snapshot.boards.find((candidate) => candidate.id === ticket.boardId);
  return board ? ticketKeyOf(board, ticket) : `#${ticket.number}`;
}

const make = Effect.gen(function* () {
  // Optional like the WebSocket handlers, so runtimes without fork services still build.
  const boards = Option.getOrElse(
    yield* Effect.serviceOption(BoardsService),
    () => unavailableBoards,
  );
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const workspaces = yield* Effect.serviceOption(TicketWorkspaces);
  const workspaceOf = (ticketId: string): Effect.Effect<TicketWorkspace | null> =>
    Option.match(workspaces, {
      onNone: () => Effect.succeed(null),
      onSome: (service) => service.find(ticketId).pipe(Effect.orElseSucceed(() => null)),
    });

  /** The calling chat, as the key boards store and the actor the timeline shows. */
  const caller = McpInvocationContext.McpInvocationContext.pipe(
    Effect.map((scope) => {
      const threadKey = `${scope.environmentId}:${scope.threadId}`;
      return { scope, threadKey, actor: `thread:${threadKey}` };
    }),
  );

  const dispatch = (command: BoardsCommand) =>
    Effect.flatMap(caller, ({ actor }) => boards.dispatch(command, actor));

  /** `environmentId:projectId` of the calling chat's project. */
  const callerProjectKey = Effect.gen(function* () {
    const { scope } = yield* caller;
    const thread = yield* snapshots
      .getThreadShellById(scope.threadId)
      .pipe(Effect.mapError(storage("Could not read this chat.")));
    if (Option.isNone(thread)) return yield* notFound("This chat was not found.");
    return `${scope.environmentId}:${thread.value.projectId}`;
  });

  const projectTitle = (projectKey: string | null) => {
    if (projectKey === null) return Effect.succeed(null);
    const projectId = projectKey.slice(projectKey.indexOf(":") + 1);
    return snapshots.getProjectShellById(ProjectId.make(projectId)).pipe(
      Effect.map((project) => (Option.isSome(project) ? project.value.title : projectKey)),
      Effect.orElseSucceed(() => projectKey),
    );
  };

  /** The named ticket, or the one this chat is linked to. */
  const resolveTicket = (snapshot: BoardsSnapshot, ref: string | undefined) =>
    Effect.gen(function* () {
      if (ref !== undefined) return yield* unwrap(findTicket(snapshot, ref));
      const { threadKey } = yield* caller;
      const linked = snapshot.tickets.find((ticket) => ticket.threadKeys.includes(threadKey));
      if (linked) return linked;
      return yield* notFound(
        "This chat is not linked to a ticket. Pass a ticket key, or link the chat with link_thread_to_ticket.",
      );
    });

  const boardOf = (snapshot: BoardsSnapshot, ticket: Ticket) => {
    const board = snapshot.boards.find((candidate) => candidate.id === ticket.boardId);
    return board ? Effect.succeed(board) : Effect.fail(notFound("The ticket's board is missing."));
  };

  /** Re-reads the ticket after a write, for the reply. */
  const changed = (ticketId: string) =>
    Effect.gen(function* () {
      const snapshot = yield* boards.snapshot;
      const ticket = yield* unwrap(findTicket(snapshot, ticketId));
      const board = yield* boardOf(snapshot, ticket);
      const column = board.columns.find((candidate) => candidate.id === ticket.columnId);
      return {
        key: ticketKeyOf(board, ticket),
        column: column?.name ?? "",
        path: ticketPath(board, ticket),
      };
    });

  const summarizeBoard = (snapshot: BoardsSnapshot, board: Board) =>
    Effect.gen(function* () {
      const live = snapshot.tickets.filter(
        (ticket) => ticket.boardId === board.id && ticket.archivedAt === null,
      );
      return {
        key: board.key,
        name: board.name,
        defaultProject: yield* projectTitle(board.defaultProjectKey),
        archived: board.archivedAt !== null,
        columns: board.columns
          .toSorted((a, b) => a.position - b.position)
          .map((column) => ({
            name: column.name,
            tickets: live.filter((ticket) => ticket.columnId === column.id).length,
          })),
      } satisfies BoardSummary;
    });

  const summarizeTicket = (snapshot: BoardsSnapshot, ticket: Ticket): TicketSummary => {
    const board = snapshot.boards.find((candidate) => candidate.id === ticket.boardId);
    const column = board?.columns.find((candidate) => candidate.id === ticket.columnId);
    return {
      key: labelOf(snapshot, ticket),
      title: ticket.title,
      column: column?.name ?? "",
      status: ticket.status,
      priority: ticket.priority,
      criteriaChecked: ticket.criteria.filter((criterion) => criterion.checked).length,
      criteriaTotal: ticket.criteria.length,
      blockedBy: blockersOf(snapshot, ticket).map((blocker) => labelOf(snapshot, blocker)),
      flag: ticket.flag ? { level: ticket.flag.level, reason: ticket.flag.reason } : null,
      linkedChats: ticket.threadKeys.length,
    };
  };

  return BoardsToolkit.of({
    list_boards: ({ includeArchived }) =>
      Effect.gen(function* () {
        const snapshot = yield* boards.snapshot;
        const visible = snapshot.boards
          .filter((board) => includeArchived === true || board.archivedAt === null)
          .toSorted((a, b) => a.position - b.position);
        return {
          boards: yield* Effect.forEach(visible, (board) => summarizeBoard(snapshot, board)),
        };
      }),

    list_tickets: (input) =>
      Effect.gen(function* () {
        const snapshot = yield* boards.snapshot;
        const board =
          input.board === undefined ? undefined : yield* unwrap(findBoard(snapshot, input.board));
        if (input.column !== undefined && board === undefined) {
          return yield* new BoardsCommandError({
            code: "invalid",
            message: "Pass board with column.",
          });
        }
        const column =
          input.column === undefined || board === undefined
            ? undefined
            : yield* unwrap(findColumn(board, input.column));
        return {
          tickets: filterTickets(snapshot, {
            board,
            column,
            query: input.query,
            includeArchived: input.includeArchived,
          }).map((ticket) => summarizeTicket(snapshot, ticket)),
        };
      }),

    get_ticket: ({ ticket: ref }) =>
      Effect.gen(function* () {
        const snapshot = yield* boards.snapshot;
        const ticket = yield* resolveTicket(snapshot, ref);
        const board = yield* boardOf(snapshot, ticket);
        const column = board.columns.find((candidate) => candidate.id === ticket.columnId);
        const detail = yield* Stream.runHead(boards.ticketDetailStream(ticket.id));
        const comments = Option.match(detail, {
          onNone: () => [],
          onSome: (value) => value.comments,
        });
        const { threadKey, scope } = yield* caller;
        const linkedChats = yield* Effect.forEach(ticket.threadKeys, (key) => {
          const separator = key.indexOf(":");
          const sameEnvironment = key.slice(0, separator) === scope.environmentId;
          if (!sameEnvironment)
            return Effect.succeed({ title: "Chat on another environment", threadKey: key });
          return snapshots.getThreadShellById(ThreadId.make(key.slice(separator + 1))).pipe(
            Effect.map((thread) => ({
              title: Option.isSome(thread) ? thread.value.title : "Chat not started yet",
              threadKey: key,
            })),
            Effect.orElseSucceed(() => ({ title: "Chat", threadKey: key })),
          );
        });
        return {
          key: ticketKeyOf(board, ticket),
          board: board.name,
          title: ticket.title,
          description: ticket.description,
          column: column?.name ?? "",
          status: ticket.status,
          priority: ticket.priority,
          project: yield* projectTitle(ticket.projectKey ?? board.defaultProjectKey),
          flag: ticket.flag ? { level: ticket.flag.level, reason: ticket.flag.reason } : null,
          criteria: ticket.criteria
            .toSorted((a, b) => a.position - b.position)
            .map((criterion, index) => ({
              number: index + 1,
              text: criterion.text,
              checked: criterion.checked,
            })),
          requires: ticket.requires.flatMap((id) => {
            const required = snapshot.tickets.find((candidate) => candidate.id === id);
            return required
              ? [
                  {
                    key: labelOf(snapshot, required),
                    title: required.title,
                    done: required.status === "done",
                  },
                ]
              : [];
          }),
          blockedBy: blockersOf(snapshot, ticket).map((blocker) => labelOf(snapshot, blocker)),
          latestHandoff: comments.toReversed().find((comment) => comment.isHandoff)?.body ?? null,
          comments: comments.map((comment) => ({
            author: comment.author === "user" ? "user" : "agent",
            body: comment.body,
            handoff: comment.isHandoff,
            createdAt: comment.createdAt,
          })),
          linkedChats,
          thisChatIsLinked: ticket.threadKeys.includes(threadKey),
          workspace: yield* workspaceOf(ticket.id).pipe(
            Effect.map((workspace) =>
              workspace
                ? {
                    path: workspace.path,
                    repos: workspace.repos.map(({ repo, checkout, path, branch, startFrom }) => ({
                      repo,
                      checkout,
                      path,
                      branch,
                      startFrom,
                    })),
                  }
                : null,
            ),
          ),
          path: ticketPath(board, ticket),
        } satisfies TicketDetailResult;
      }),

    create_board: (input) =>
      Effect.gen(function* () {
        const defaultProjectKey =
          input.useThisChatsProject === true ? yield* callerProjectKey : null;
        yield* dispatch({
          type: "board.create",
          name: input.name,
          key: input.key,
          defaultProjectKey,
        });
        const snapshot = yield* boards.snapshot;
        const board = yield* unwrap(findBoard(snapshot, input.key));
        return yield* summarizeBoard(snapshot, board);
      }),

    create_ticket: (input) =>
      Effect.gen(function* () {
        const snapshot = yield* boards.snapshot;
        const board = yield* unwrap(findBoard(snapshot, input.board));
        const column =
          input.column === undefined ? undefined : yield* unwrap(findColumn(board, input.column));
        const requires = yield* Effect.forEach(input.requires ?? [], (ref) =>
          unwrap(findTicket(snapshot, ref)).pipe(Effect.map((ticket) => ticket.id)),
        );
        const projectKey = input.useThisChatsProject === true ? yield* callerProjectKey : undefined;
        const result = yield* dispatch({
          type: "ticket.create",
          boardId: board.id,
          title: input.title,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(column ? { columnId: column.id } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(projectKey !== undefined ? { projectKey } : {}),
          ...(input.criteria ? { criteria: input.criteria } : {}),
          ...(requires.length > 0 ? { requires } : {}),
        });
        const ticketId = result.id;
        if (ticketId === null) {
          return yield* storage("The ticket was not created.")();
        }
        if (input.linkThisChat === true) {
          const { threadKey } = yield* caller;
          yield* dispatch({ type: "thread.link", threadKey, ticketId });
        }
        return yield* changed(ticketId);
      }),

    update_ticket: (input) =>
      Effect.gen(function* () {
        const snapshot = yield* boards.snapshot;
        const ticket = yield* resolveTicket(snapshot, input.ticket);
        if (
          input.title !== undefined ||
          input.description !== undefined ||
          input.priority !== undefined
        ) {
          yield* dispatch({
            type: "ticket.update",
            ticketId: ticket.id,
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
          });
        }
        if (input.status !== undefined) {
          yield* dispatch({ type: "ticket.setStatus", ticketId: ticket.id, status: input.status });
        }
        // Resolve every criterion before writing, so a bad reference changes nothing.
        const check = yield* Effect.forEach(input.checkCriteria ?? [], (ref) =>
          unwrap(findCriterion(ticket, ref)),
        );
        const uncheck = yield* Effect.forEach(input.uncheckCriteria ?? [], (ref) =>
          unwrap(findCriterion(ticket, ref)),
        );
        const remove = yield* Effect.forEach(input.removeCriteria ?? [], (ref) =>
          unwrap(findCriterion(ticket, ref)),
        );
        const addRequires = yield* Effect.forEach(input.addRequires ?? [], (ref) =>
          unwrap(findTicket(snapshot, ref)),
        );
        const removeRequires = yield* Effect.forEach(input.removeRequires ?? [], (ref) =>
          unwrap(findTicket(snapshot, ref)),
        );
        for (const criterion of check) {
          yield* dispatch({ type: "criterion.update", criterionId: criterion.id, checked: true });
        }
        for (const criterion of uncheck) {
          yield* dispatch({ type: "criterion.update", criterionId: criterion.id, checked: false });
        }
        for (const criterion of remove) {
          yield* dispatch({ type: "criterion.delete", criterionId: criterion.id });
        }
        for (const text of input.addCriteria ?? []) {
          yield* dispatch({ type: "criterion.add", ticketId: ticket.id, text });
        }
        for (const required of addRequires) {
          yield* dispatch({
            type: "requirement.add",
            ticketId: ticket.id,
            requiresTicketId: required.id,
          });
        }
        for (const required of removeRequires) {
          yield* dispatch({
            type: "requirement.remove",
            ticketId: ticket.id,
            requiresTicketId: required.id,
          });
        }
        return yield* changed(ticket.id);
      }),

    move_ticket: (input) =>
      Effect.gen(function* () {
        const snapshot = yield* boards.snapshot;
        const ticket = yield* resolveTicket(snapshot, input.ticket);
        const board = yield* boardOf(snapshot, ticket);
        const column = yield* unwrap(findColumn(board, input.column));
        if (column.id !== ticket.columnId) {
          yield* dispatch({ type: "ticket.move", ticketId: ticket.id, columnId: column.id });
        }
        return yield* changed(ticket.id);
      }),

    add_comment: (input) =>
      Effect.gen(function* () {
        const snapshot = yield* boards.snapshot;
        const ticket = yield* resolveTicket(snapshot, input.ticket);
        yield* dispatch({
          type: "comment.add",
          ticketId: ticket.id,
          body: input.body,
          ...(input.handoff === true ? { isHandoff: true } : {}),
        });
        return yield* changed(ticket.id);
      }),

    request_human: (input) =>
      Effect.gen(function* () {
        const snapshot = yield* boards.snapshot;
        const ticket = yield* resolveTicket(snapshot, input.ticket);
        yield* dispatch({
          type: "ticket.flag",
          ticketId: ticket.id,
          level: "warning",
          reason: input.reason,
        });
        return yield* changed(ticket.id);
      }),

    link_thread_to_ticket: ({ ticket: ref }) =>
      Effect.gen(function* () {
        const { threadKey } = yield* caller;
        if (ref === undefined) {
          yield* dispatch({ type: "thread.link", threadKey, ticketId: null });
          return { linkedTo: null };
        }
        const snapshot = yield* boards.snapshot;
        const ticket = yield* unwrap(findTicket(snapshot, ref));
        yield* dispatch({ type: "thread.link", threadKey, ticketId: ticket.id });
        return { linkedTo: labelOf(snapshot, ticket) };
      }),

    remove_ticket_workspace: ({ ticket: ref, force }) =>
      Effect.gen(function* () {
        const snapshot = yield* boards.snapshot;
        const ticket = yield* resolveTicket(snapshot, ref);
        if (Option.isNone(workspaces)) {
          return yield* new BoardsCommandError({
            code: "storage",
            message: "Ticket workspaces are not available on this server.",
          });
        }
        const existing = yield* workspaceOf(ticket.id);
        if (!existing) return { removed: false };
        yield* workspaces.value
          .dispatch({ type: "workspace.remove", ticketId: ticket.id, ...(force ? { force } : {}) })
          .pipe(
            Effect.mapError(
              (error) =>
                new BoardsCommandError({
                  code: error.code === "not-found" ? "not-found" : "invalid",
                  message: error.message,
                }),
            ),
          );
        return { removed: true };
      }),
  });
});

export const BoardsToolkitHandlersLive = BoardsToolkit.toLayer(make);
