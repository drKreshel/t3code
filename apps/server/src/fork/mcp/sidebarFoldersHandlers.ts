import { OrchestratorMcpFailure, SidebarFoldersError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as SidebarFolders from "../sidebarFolders/SidebarFolders.ts";
import { SidebarFoldersToolkit } from "./sidebarFoldersTools.ts";

const make = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(SidebarFolders.SidebarFolders);
  const withService = <A>(
    use: (
      folders: SidebarFolders.SidebarFolders["Service"],
    ) => Effect.Effect<A, SidebarFoldersError>,
  ) =>
    Option.match(service, {
      onNone: () => Effect.fail(SidebarFoldersError.fromCode("unavailable")),
      onSome: use,
    });

  return {
    list_sidebar_folders: McpToolAccess.readsAsCaller((input) =>
      withService((folders) => folders.list(input.clientId)),
    ),
    delete_sidebar_folder: McpToolAccess.actsAsCaller((input) =>
      withService((folders) => folders.delete(input.clientId, input.folderId)),
    ),
    settle_sidebar_folder: McpToolAccess.actsAsCaller((input) =>
      withService((folders) =>
        folders.setSettled(input.clientId, input.folderId, input.settled ?? true),
      ),
    ),
    set_sidebar_folder_icon: McpToolAccess.actsAsCaller((input) =>
      withService((folders) => folders.setIcon(input.clientId, input.folderId, input.icon)),
    ),
    move_thread_to_sidebar_folder: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        Effect.gen(function* () {
          const invocation = yield* McpInvocationContext.McpInvocationContext;
          const threadId = input.threadId ?? invocation.thread?.threadId;
          if (threadId === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "target_required",
              message: "threadId is required when this tool is called outside a T3 thread.",
            });
          }
          return yield* withService((folders) =>
            folders.moveThread(
              input.clientId,
              { environmentId: invocation.environmentId, threadId },
              input.folderId,
            ),
          );
        }),
    ),
  } satisfies McpToolAccess.Handlers<typeof SidebarFoldersToolkit.tools>;
});

export const SidebarFoldersToolkitHandlersLive = McpToolAccess.toLayer(SidebarFoldersToolkit, make);
