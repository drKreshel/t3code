import {
  OrchestratorMcpFailure,
  OrganizingIconOverride,
  SidebarFolderDeletionResult,
  SidebarFolderIconResult,
  SidebarFolderListing,
  SidebarFolderSettlementResult,
  SidebarFolderThreadMoveResult,
  SidebarFoldersError,
  ThreadId,
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
    "List sidebar folders in connected writable web and desktop clients, including icons, empty folders, nesting, chat counts, settled state, and ticket or scheduled task routing. Sidebar folders are client-local. Client IDs last only until that client reloads or restarts; list again before changing a layout and use the returned clientId and folder id with settle_sidebar_folder, set_sidebar_folder_icon, delete_sidebar_folder, or move_thread_to_sidebar_folder. Clearing a ticket's folder field leaves the sidebar folder behind. Unresponsive clients are reported in failures; healthy layouts remain available.",
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

const SettleSidebarFolder = Tool.make("settle_sidebar_folder", {
  ...shared,
  description:
    "Settle or un-settle a top-level sidebar folder in the selected connected client, using clientId and folderId from list_sidebar_folders. Settling also settles every eligible chat in the folder and its subfolders. Set settled=false to return the folder to the active Folders section; its chats stay settled, matching the UI. The layout is client-local, so repeat for another listed client when desired.",
  parameters: Schema.Struct({
    clientId: TrimmedNonEmptyString,
    folderId: TrimmedNonEmptyString,
    settled: Schema.optionalKey(Schema.Boolean),
  }),
  success: SidebarFolderSettlementResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SetSidebarFolderIcon = Tool.make("set_sidebar_folder_icon", {
  ...shared,
  description:
    "Set or reset a sidebar folder's icon in the selected connected client, using clientId and folderId from list_sidebar_folders. The icon may be a Lucide name and color, emoji, monogram text and color, or a bitmap image data URL no longer than 32 KiB. Set icon=null to restore the folder glyph. The layout is client-local, so repeat for another listed client when desired.",
  parameters: Schema.Struct({
    clientId: TrimmedNonEmptyString,
    folderId: TrimmedNonEmptyString,
    icon: Schema.NullOr(OrganizingIconOverride),
  }),
  success: SidebarFolderIconResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const MoveThreadToSidebarFolder = Tool.make("move_thread_to_sidebar_folder", {
  ...shared,
  description:
    "Move a thread into a sidebar folder in the selected connected web or desktop client. Use clientId and folderId from list_sidebar_folders. Omit threadId for this thread; pass another thread ID from this environment to file that chat. Set folderId=null to remove the thread from its folder. The layout is client-local, so repeat for another listed client when desired.",
  parameters: Schema.Struct({
    clientId: TrimmedNonEmptyString,
    threadId: Schema.optional(ThreadId),
    folderId: Schema.NullOr(TrimmedNonEmptyString),
  }),
  success: SidebarFolderThreadMoveResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const SidebarFoldersToolkit = Toolkit.make(
  ListSidebarFolders,
  DeleteSidebarFolder,
  SettleSidebarFolder,
  SetSidebarFolderIcon,
  MoveThreadToSidebarFolder,
);
