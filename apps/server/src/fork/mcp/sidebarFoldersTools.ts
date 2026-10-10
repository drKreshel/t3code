import {
  OrchestratorMcpFailure,
  SidebarFolderDeletionResult,
  SidebarFolderListing,
  SidebarFoldersError,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";

const shared = {
  failure: Schema.Union([SidebarFoldersError, OrchestratorMcpFailure]),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

const ListSidebarFolders = Tool.make("list_sidebar_folders", {
  ...shared,
  description:
    "List sidebar folders in connected writable web and desktop clients, including empty folders, nesting, chat counts, and ticket or scheduled task routing. Sidebar folders are client-local. Client IDs last only until that client reloads or restarts; list again before deleting and use the returned clientId and folder id with delete_sidebar_folder. Clearing a ticket's folder field leaves the sidebar folder behind. Unresponsive clients are reported in failures; healthy layouts remain available.",
  parameters: Schema.Struct({ clientId: Schema.optionalKey(TrimmedNonEmptyString) }),
  success: SidebarFolderListing,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DeleteSidebarFolder = Tool.make("delete_sidebar_folder", {
  ...shared,
  description:
    "Delete a sidebar folder and its subfolders in the selected connected client, using clientId and folderId from list_sidebar_folders. Chats are preserved and return to the main list. Ticket and scheduled task folder paths are queued for clearing, just as when using Delete folder in the UI. This does not delete any directory on disk.",
  parameters: Schema.Struct({ clientId: TrimmedNonEmptyString, folderId: TrimmedNonEmptyString }),
  success: SidebarFolderDeletionResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const SidebarFoldersToolkit = Toolkit.make(ListSidebarFolders, DeleteSidebarFolder);
