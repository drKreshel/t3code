import { SidebarFoldersError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

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
      onNone: () => Effect.fail(new SidebarFoldersError({ code: "unavailable" })),
      onSome: use,
    });

  return {
    list_sidebar_folders: McpToolAccess.readsAsCaller((input) =>
      withService((folders) => folders.list(input.clientId)),
    ),
    delete_sidebar_folder: McpToolAccess.actsAsCaller((input) =>
      withService((folders) => folders.delete(input.clientId, input.folderId)),
    ),
  } satisfies McpToolAccess.Handlers<typeof SidebarFoldersToolkit.tools>;
});

export const SidebarFoldersToolkitHandlersLive = McpToolAccess.toLayer(SidebarFoldersToolkit, make);
