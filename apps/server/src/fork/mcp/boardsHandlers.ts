import {
  type Board,
  BoardsCommandError,
  CommandId,
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
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { randomUuidV4 } from "../../orchestration-v2/RandomUuid.ts";
import { BoardsService } from "../boards/BoardsService.ts";
import { unavailableBoards } from "../rpcHandlers.ts";
import { BoardTemplates } from "../templates/BoardTemplates.ts";
import { TaskFolders } from "../taskFolders/TaskFolders.ts";
import { TicketWorkspaces } from "../workspaces/TicketWorkspaces.ts";
import {
  filterTickets,
  findBoard,
  findColumn,
  findCriterion,
  findTicket,
  type Lookup,
  planColumnEdits,
  ticketKeyOf,
} from "./boardsToolLogic.ts";
import {
  type BoardSummary,
  BoardsToolkit,
  type TicketDetailResult,
  type TicketSummary,
} from "./boardsTools.ts";

const notFound = (message: string) => new BoardsCommandError({ code: "not-found", message });
const invalid = (message: string) => new BoardsCommandError({ code: "invalid", message });
const storage = (message: string) => () => new BoardsCommandError({ code: "storage", message });

const unwrap = <A>(lookup: Lookup<A>): Effect.Effect<A, BoardsCommandError> =>
  lookup.ok ? Effect.succeed(lookup.value) : Effect.fail(notFound(lookup.message));

const ticketPath = (board: Board, ticket: Ticket) => `/boards/${board.key}/${ticket.number}`;

/** The name of the column a ticket sits in. */
function columnNameOf(snapshot: BoardsSnapshot, ticket: Ticket): string {
  const board = snapshot.boards.find((candidate) => candidate.id === ticket.boardId);
  return board?.columns.find((column) => column.id === ticket.columnId)?.name ?? "";
}

/** Required tickets that still exist. */
function requiredTickets(snapshot: BoardsSnapshot, ticket: Ticket): Ticket[] {
  return ticket.requires.flatMap((id) => {
    const required = snapshot.tickets.find((candidate) => candidate.id === id);
    return required ? [required] : [];
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
  const threads = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const workspaces = yield* Effect.serviceOption(TicketWorkspaces);
  const templates = yield* Effect.serviceOption(BoardTemplates);
  const taskFolders = yield* Effect.serviceOption(TaskFolders);
  const workspaceOf = (ticketId: string): Effect.Effect<TicketWorkspace | null> =>
    Option.match(workspaces, {
      onNone: () => Effect.succeed(null),
      onSome: (service) => service.find(ticketId).pipe(Effect.orElseSucceed(() => null)),
    });

  /** The calling chat, as the key boards store and the actor the timeline shows. */
  const caller = McpInvocationContext.McpInvocationContext.pipe(
    Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "Board tools")),
    Effect.mapError(() => invalid("Board tools require an agent running in a T3 thread.")),
    Effect.map((scope) => {
      const threadKey = `${scope.environmentId}:${scope.thread.threadId}`;
      return { scope, threadKey, actor: `thread:${threadKey}` };
    }),
  );

  const dispatch = (command: BoardsCommand) =>
    Effect.flatMap(caller, ({ actor }) => boards.dispatch(command, actor));

  /** `environmentId:projectId` of the calling chat's project. */
  const callerProjectKey = Effect.gen(function* () {
    const { scope } = yield* caller;
    const thread = yield* threads
      .getThreadShell(scope.thread.threadId)
      .pipe(Effect.mapError(storage("Could not read this chat.")));
    if (thread === null) return yield* notFound("This chat was not found.");
    return `${scope.environmentId}:${thread.projectId}`;
  });

  const projectTitle = (projectKey: string | null) => {
    if (projectKey === null) return Effect.succeed(null);
    const projectId = projectKey.slice(projectKey.indexOf(":") + 1);
    return projects.getShell(ProjectId.make(projectId)).pipe(
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
        newChatMessage: board.newChatMessage,
        archived: board.archivedAt !== null,
        columns: board.columns
          .toSorted((a, b) => a.position - b.position)
          .map((column) => {
            const target = board.columns.find((other) => other.id === column.autoMove?.toColumnId);
            return {
              name: column.name,
              color: column.color,
              tickets: live.filter((ticket) => ticket.columnId === column.id).length,
              autoMove:
                column.autoMove && target
                  ? { afterDays: column.autoMove.afterDays, to: target.name }
                  : null,
            };
          }),
      } satisfies BoardSummary;
    });

  const summarizeTicket = (snapshot: BoardsSnapshot, ticket: Ticket): TicketSummary => {
    const board = snapshot.boards.find((candidate) => candidate.id === ticket.boardId);
    const column = board?.columns.find((candidate) => candidate.id === ticket.columnId);
    return {
      key: labelOf(snapshot, ticket),
      title: ticket.title,
      column: column?.name ?? "",
      priority: ticket.priority,
      criteriaChecked: ticket.criteria.filter((criterion) => criterion.checked).length,
      criteriaTotal: ticket.criteria.length,
      requires: requiredTickets(snapshot, ticket).map(
        (required) => `${labelOf(snapshot, required)} (${columnNameOf(snapshot, required)})`,
      ),
      flag: ticket.flag ? { level: ticket.flag.level, reason: ticket.flag.reason } : null,
      linkedChats: ticket.threadKeys.length,
    };
  };

  return {
    list_boards: McpToolAccess.reads(({ includeArchived }) =>
      Effect.gen(function* () {
        const snapshot = yield* boards.snapshot;
        const visible = snapshot.boards
          .filter((board) => includeArchived === true || board.archivedAt === null)
          .toSorted((a, b) => a.position - b.position);
        return {
          boards: yield* Effect.forEach(visible, (board) => summarizeBoard(snapshot, board)),
        };
      }),
    ),
    list_tickets: McpToolAccess.reads((input) =>
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
    ),
    get_ticket: McpToolAccess.reads(({ ticket: ref }) =>
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
          return threads.getThreadShell(ThreadId.make(key.slice(separator + 1))).pipe(
            Effect.map((thread) => ({
              title: thread !== null ? thread.title : "Chat not started yet",
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
          priority: ticket.priority,
          project: yield* projectTitle(ticket.projectKey ?? board.defaultProjectKey),
          folder: ticket.folder ?? null,
          history: Option.isSome(detail)
            ? detail.value.events.map(({ kind, payload, actor, createdAt }) => ({
                kind,
                payload,
                actor,
                createdAt,
              }))
            : [],
          flag: ticket.flag ? { level: ticket.flag.level, reason: ticket.flag.reason } : null,
          criteria: ticket.criteria
            .toSorted((a, b) => a.position - b.position)
            .map((criterion, index) => ({
              number: index + 1,
              text: criterion.text,
              checked: criterion.checked,
            })),
          requires: requiredTickets(snapshot, ticket).map((required) => ({
            key: labelOf(snapshot, required),
            title: required.title,
            column: columnNameOf(snapshot, required),
          })),
          latestHandoff: comments.toReversed().find((comment) => comment.isHandoff)?.body ?? null,
          comments: comments.map((comment) => ({
            author: comment.author,
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
    ),
    create_board: McpToolAccess.writes((input) =>
      Effect.gen(function* () {
        if (input.template !== undefined && input.columns !== undefined) {
          return yield* invalid("Pass either template or columns.");
        }
        const names = new Set(input.columns?.map((column) => column.name.toLowerCase()));
        if (input.columns !== undefined && names.size !== input.columns.length) {
          return yield* invalid("Column names must differ.");
        }
        const defaultProjectKey =
          input.useThisChatsProject === true ? yield* callerProjectKey : null;
        if (input.template === undefined) {
          yield* dispatch({
            type: "board.create",
            name: input.name,
            key: input.key,
            defaultProjectKey,
            ...(input.columns
              ? {
                  columns: input.columns.map(({ name, color }) => ({ name, color: color ?? null })),
                }
              : {}),
          });
        } else {
          if (Option.isNone(templates)) return yield* notFound("Board templates are unavailable.");
          const service = templates.value;
          const wanted = input.template.trim().toLowerCase();
          const { templates: all } = yield* service.snapshot;
          const template = all.find((candidate) => candidate.name.toLowerCase() === wanted);
          if (!template) {
            return yield* notFound(
              `No template "${input.template}". Templates: ${all.map((t) => t.name).join(", ")}.`,
            );
          }
          const { actor } = yield* caller;
          yield* service.dispatch(
            {
              type: "board.create",
              templateId: template.id,
              name: input.name,
              key: input.key,
              defaultProjectKey,
            },
            actor,
          );
        }
        const snapshot = yield* boards.snapshot;
        const board = yield* unwrap(findBoard(snapshot, input.key));
        return yield* summarizeBoard(snapshot, board);
      }),
    ),
    update_board: McpToolAccess.writes((input) =>
      Effect.gen(function* () {
        const snapshot = yield* boards.snapshot;
        const board = yield* unwrap(findBoard(snapshot, input.board));
        const tickets = snapshot.tickets.filter((ticket) => ticket.boardId === board.id);
        const plan = planColumnEdits(board, tickets, input);
        if (!plan.ok) return yield* invalid(plan.message);
        const { updates, adds, removes, order } = plan.value;

        // The board update runs first: a taken key is refused before any column changes.
        const defaultProjectKey =
          input.useThisChatsProject === undefined
            ? undefined
            : input.useThisChatsProject
              ? yield* callerProjectKey
              : null;
        if (
          input.name !== undefined ||
          input.key !== undefined ||
          defaultProjectKey !== undefined ||
          input.newChatMessage !== undefined
        ) {
          yield* dispatch({
            type: "board.update",
            boardId: board.id,
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.key !== undefined ? { key: input.key } : {}),
            ...(defaultProjectKey !== undefined ? { defaultProjectKey } : {}),
            ...(input.newChatMessage !== undefined ? { newChatMessage: input.newChatMessage } : {}),
          });
        }
        if (input.archived !== undefined && input.archived !== (board.archivedAt !== null)) {
          yield* dispatch({ type: "board.archive", boardId: board.id, archived: input.archived });
        }

        // Column ids by their names after this call, so renames can swap or reuse names.
        const renamed = new Map(updates.map(({ column, name }) => [column.id, name]));
        const removedIds = new Set(removes.map(({ column }) => column.id));
        const idByName = new Map(
          board.columns
            .filter((column) => !removedIds.has(column.id))
            .map((column) => [(renamed.get(column.id) ?? column.name).toLowerCase(), column.id]),
        );
        for (const { column, name, color } of updates) {
          yield* dispatch({
            type: "column.update",
            columnId: column.id,
            ...(name !== undefined ? { name } : {}),
            ...(color !== undefined ? { color } : {}),
          });
        }
        for (const { name, color } of adds) {
          const { id } = yield* dispatch({ type: "column.create", boardId: board.id, name, color });
          if (id !== null) idByName.set(name.toLowerCase(), id);
        }
        const idOf = (name: string) =>
          Effect.fromNullishOr(idByName.get(name.toLowerCase())).pipe(
            Effect.mapError(storage(`Column "${name}" was not created.`)),
          );
        for (const { column, moveTicketsTo } of removes) {
          yield* dispatch({
            type: "column.delete",
            columnId: column.id,
            moveTicketsTo: yield* idOf(moveTicketsTo),
          });
        }
        // After adds, so a move can target a column this call creates.
        for (const { column, autoMove } of updates) {
          if (autoMove === undefined || removedIds.has(column.id)) continue;
          yield* dispatch({
            type: "column.update",
            columnId: column.id,
            autoMove:
              autoMove === null
                ? null
                : { afterDays: autoMove.afterDays, toColumnId: yield* idOf(autoMove.to) },
          });
        }
        if (order !== null) {
          for (const [index, name] of order.entries()) {
            yield* dispatch({
              type: "column.reorder",
              columnId: yield* idOf(name),
              position: index + 1,
            });
          }
        }

        const after = yield* boards.snapshot;
        const updated = after.boards.find((candidate) => candidate.id === board.id);
        if (!updated) return yield* notFound("The board is missing.");
        return yield* summarizeBoard(after, updated);
      }),
    ),
    create_ticket: McpToolAccess.writes((input) =>
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
          ...(input.folder !== undefined ? { folder: input.folder } : {}),
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
    ),
    update_ticket: McpToolAccess.writes((input) =>
      Effect.gen(function* () {
        const snapshot = yield* boards.snapshot;
        const ticket = yield* resolveTicket(snapshot, input.ticket);
        if (
          input.title !== undefined ||
          input.description !== undefined ||
          input.priority !== undefined ||
          input.folder !== undefined
        ) {
          yield* dispatch({
            type: "ticket.update",
            ticketId: ticket.id,
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
            ...(input.folder !== undefined ? { folder: input.folder } : {}),
          });
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
    ),
    move_ticket: McpToolAccess.writes((input) =>
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
    ),
    add_comment: McpToolAccess.writes((input) =>
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
    ),
    request_human: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { scope } = yield* caller;
        const id = yield* randomUuidV4;
        yield* threads
          .dispatch({
            type: "thread.request-human",
            commandId: CommandId.make(`request-human:${id}`),
            threadId: scope.thread.threadId,
            reason: input.reason,
            ...(input.options === undefined ? {} : { options: input.options }),
          })
          .pipe(Effect.mapError(storage("Could not request help in this chat.")));
        return {
          threadId: scope.thread.threadId,
          path: `/${scope.environmentId}/${scope.thread.threadId}`,
        };
      }),
    ),
    link_thread_to_ticket: McpToolAccess.actsAsCaller(({ ticket: ref }) =>
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
    ),
    file_scheduled_task_runs: McpToolAccess.writes(({ scheduledTaskId, folder }) =>
      Effect.gen(function* () {
        if (Option.isNone(taskFolders)) {
          return yield* new BoardsCommandError({
            code: "storage",
            message: "Task folders are not available on this server.",
          });
        }
        yield* taskFolders.value
          .set({ taskId: scheduledTaskId, folder })
          .pipe(
            Effect.mapError(
              (error) => new BoardsCommandError({ code: "storage", message: error.message }),
            ),
          );
        return { scheduledTaskId, folder };
      }),
    ),
    remove_ticket_workspace: McpToolAccess.writes(({ ticket: ref, force }) =>
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
    ),
  } satisfies McpToolAccess.Handlers<typeof BoardsToolkit.tools>;
});

export const BoardsToolkitHandlersLive = McpToolAccess.toLayer(BoardsToolkit, make);
