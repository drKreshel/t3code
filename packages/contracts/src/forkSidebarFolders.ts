import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ScopedThreadRef } from "./environment.ts";
import { OrganizingIconOverride } from "./forkOrganizingIcon.ts";

export const FORK_SIDEBAR_FOLDERS_WS_METHODS = {
  connect: "fork.sidebarFolders.connect",
  claim: "fork.sidebarFolders.claim",
  respond: "fork.sidebarFolders.respond",
} as const;

const SidebarFoldersErrorCode = Schema.Literals([
  "unavailable",
  "client-disconnected",
  "busy",
  "timeout",
  "not-found",
  "invalid-path",
  "nested-folder", // Older clients may still reject subfolder settlement.
  "thread-not-found",
  "thread-settlement-failed",
  "invalid-response",
]);

const errorMessages = {
  unavailable: "No writable web or desktop client is connected for sidebar folder tools.",
  "client-disconnected":
    "The selected sidebar folder client is no longer connected. Client IDs change after a reload or restart. List folders again before retrying.",
  busy: "The sidebar folder client is busy. Wait for current calls to finish.",
  timeout: "The sidebar folder client did not respond in time. List folders again before retrying.",
  "not-found": "The sidebar folder was not found in the selected client.",
  "invalid-path": "The sidebar folder path must contain slash-separated, non-empty names.",
  "nested-folder": "The selected client does not support settling subfolders. Update it and retry.",
  "thread-not-found": "The thread was not found in the selected client.",
  "thread-settlement-failed":
    "The folder was not settled because one or more of its chats could not be settled.",
  "invalid-response": "The sidebar folder client returned an invalid response.",
};

export class SidebarFoldersError extends Schema.TaggedError<SidebarFoldersError>()(
  "SidebarFoldersError",
  { code: SidebarFoldersErrorCode, message: Schema.String },
) {
  static fromCode(code: typeof SidebarFoldersErrorCode.Type): SidebarFoldersError {
    return new SidebarFoldersError({ code, message: errorMessages[code] });
  }
}

export const SidebarFolderClient = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
});
export type SidebarFolderClient = typeof SidebarFolderClient.Type;

export const SidebarFolderSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  path: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  icon: Schema.NullOr(OrganizingIconOverride),
  threadCount: NonNegativeInt,
  subtreeThreadCount: NonNegativeInt,
  settled: Schema.Boolean,
  routedTickets: NonNegativeInt,
  routedTasks: NonNegativeInt,
});
export type SidebarFolderSummary = typeof SidebarFolderSummary.Type;

export const SidebarFolderListing = Schema.Struct({
  clients: Schema.Array(
    Schema.Struct({
      ...SidebarFolderClient.fields,
      folders: Schema.Array(SidebarFolderSummary),
    }),
  ),
  failures: Schema.Array(
    Schema.Struct({
      ...SidebarFolderClient.fields,
      error: SidebarFoldersError,
    }),
  ),
});
export type SidebarFolderListing = typeof SidebarFolderListing.Type;

export const SidebarFolderAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("list") }),
  Schema.Struct({ type: Schema.Literal("create"), path: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("delete"), folderId: TrimmedNonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("set-icon"),
    folderId: TrimmedNonEmptyString,
    icon: Schema.NullOr(OrganizingIconOverride),
  }),
  Schema.Struct({
    type: Schema.Literal("set-settled"),
    folderId: TrimmedNonEmptyString,
    settled: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("move-thread"),
    thread: ScopedThreadRef,
    folderId: Schema.NullOr(TrimmedNonEmptyString),
  }),
]);
export type SidebarFolderAction = typeof SidebarFolderAction.Type;

export const SidebarFolderCreationResult = Schema.Struct({
  type: Schema.Literal("folder-created"),
  folderId: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  createdFolderIds: Schema.Array(TrimmedNonEmptyString),
});

export const SidebarFolderDeletionResult = Schema.Struct({
  type: Schema.Literal("deleted"),
  deletedFolderIds: Schema.Array(Schema.String),
  releasedThreadCount: NonNegativeInt,
  queuedTicketFolderClears: NonNegativeInt,
  queuedTaskFolderClears: NonNegativeInt,
});

export const SidebarFolderThreadMoveResult = Schema.Struct({
  type: Schema.Literal("thread-moved"),
  thread: ScopedThreadRef,
  folderId: Schema.NullOr(TrimmedNonEmptyString),
});

export const SidebarFolderSettlementResult = Schema.Struct({
  type: Schema.Literal("folder-settled"),
  folderId: TrimmedNonEmptyString,
  settled: Schema.Boolean,
});

export const SidebarFolderIconResult = Schema.Struct({
  type: Schema.Literal("folder-icon-updated"),
  folderId: TrimmedNonEmptyString,
  icon: Schema.NullOr(OrganizingIconOverride),
});

export const SidebarFolderResult = Schema.Union([
  Schema.Struct({ type: Schema.Literal("listed"), folders: Schema.Array(SidebarFolderSummary) }),
  SidebarFolderCreationResult,
  SidebarFolderDeletionResult,
  SidebarFolderIconResult,
  SidebarFolderSettlementResult,
  SidebarFolderThreadMoveResult,
]);
export type SidebarFolderResult = typeof SidebarFolderResult.Type;

export const SidebarFolderStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("connected"), connectionId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("request"),
    connectionId: Schema.String,
    requestId: Schema.String,
    action: SidebarFolderAction,
  }),
]);
export type SidebarFolderStreamEvent = typeof SidebarFolderStreamEvent.Type;

export const SidebarFolderRequestRef = Schema.Struct({
  clientId: Schema.String,
  connectionId: Schema.String,
  requestId: Schema.String,
});
export type SidebarFolderRequestRef = typeof SidebarFolderRequestRef.Type;

export const SidebarFolderReply = Schema.Struct({
  ...SidebarFolderRequestRef.fields,
  result: Schema.optionalKey(SidebarFolderResult),
  error: Schema.optionalKey(SidebarFoldersError),
});
export type SidebarFolderReply = typeof SidebarFolderReply.Type;

export const ForkSidebarFoldersConnectRpc = Rpc.make(FORK_SIDEBAR_FOLDERS_WS_METHODS.connect, {
  payload: SidebarFolderClient,
  success: SidebarFolderStreamEvent,
  error: SidebarFoldersError,
  stream: true,
});

export const ForkSidebarFoldersRespondRpc = Rpc.make(FORK_SIDEBAR_FOLDERS_WS_METHODS.respond, {
  payload: SidebarFolderReply,
  success: Schema.Void,
  error: SidebarFoldersError,
});

export const ForkSidebarFoldersClaimRpc = Rpc.make(FORK_SIDEBAR_FOLDERS_WS_METHODS.claim, {
  payload: SidebarFolderRequestRef,
  success: Schema.Boolean,
  error: SidebarFoldersError,
});
