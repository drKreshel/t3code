/**
 * Where a chat an agent starts goes (fork): the ticket it joins and the sidebar
 * folder it is filed in. Both are optional, and a chat given neither joins no
 * ticket and no folder. t3_thread_launch, create_threads, and delegate_task
 * check the placement before creating a chat, so a wrong ticket key creates
 * nothing.
 */
import {
  OrchestratorMcpFailure,
  type ThreadId,
  TicketFolderPath,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { BoardsService } from "../boards/BoardsService.ts";
import { TaskFolders } from "../taskFolders/TaskFolders.ts";
import { findTicket } from "./boardsToolLogic.ts";

/** Tool parameters that place a new chat; spread into a tool's parameter struct. */
export const NewChatPlacementFields = {
  ticket: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Ticket key like WEB-12 for the new chat to join. Omit for no ticket.",
    }),
  ),
  folder: Schema.optional(
    TicketFolderPath.annotate({
      description:
        "Sidebar folder for the new chat, names separated by /, in every client; it wins over its ticket's folder. Omit for no folder of its own.",
    }),
  ),
};

export interface NewChatPlacement {
  readonly ticket?: string | undefined;
  readonly folder?: string | undefined;
}

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** Checks the placement and returns the step that applies it once the chat exists. */
export const prepareNewChatPlacement = Effect.fn("fork.prepareNewChatPlacement")(function* (
  placement: NewChatPlacement,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  // Tool handlers keep the context their layer was built in, which holds the
  // fork's services; runtimes without them (upstream tests) refuse a placement.
  const boards = yield* Effect.serviceOption(BoardsService);
  const folders = yield* Effect.serviceOption(TaskFolders);
  const { ticket: ref, folder } = placement;

  let ticketId: string | null = null;
  if (ref !== undefined) {
    if (Option.isNone(boards)) return yield* invalid("Boards are not available on this server.");
    const snapshot = yield* boards.value.snapshot.pipe(
      Effect.mapError(() => invalid("Could not read the boards.")),
    );
    const lookup = findTicket(snapshot, ref);
    if (!lookup.ok) return yield* invalid(`${lookup.message} No chat was created.`);
    ticketId = lookup.value.id;
  }
  if (folder !== undefined && Option.isNone(folders))
    return yield* invalid("Chat folders are not available on this server.");

  const actor =
    scope.thread === undefined ? "agent" : `thread:${scope.environmentId}:${scope.thread.threadId}`;
  return (threadId: ThreadId) =>
    Effect.gen(function* () {
      if (ticketId !== null && Option.isSome(boards)) {
        yield* boards.value.dispatch(
          { type: "thread.link", ticketId, threadKey: `${scope.environmentId}:${threadId}` },
          actor,
        );
      }
      if (folder !== undefined && Option.isSome(folders)) {
        yield* folders.value.setChat({ threadId, folder });
      }
    }).pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: `The chat ${threadId} was created, but placing it failed: ${error.message}`,
          }),
      ),
    );
});
