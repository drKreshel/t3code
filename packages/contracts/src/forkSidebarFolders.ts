import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const FORK_SIDEBAR_FOLDERS_WS_METHODS = {
  connect: "fork.sidebarFolders.connect",
  claim: "fork.sidebarFolders.claim",
  respond: "fork.sidebarFolders.respond",
} as const;

export class SidebarFoldersError extends Schema.TaggedError<SidebarFoldersError>()(
  "SidebarFoldersError",
  {
    code: Schema.Literals([
      "unavailable",
      "client-disconnected",
      "busy",
      "timeout",
      "not-found",
      "invalid-response",
    ]),
  },
) {
  override get message(): string {
    switch (this.code) {
      case "unavailable":
        return "No writable web or desktop client is connected for sidebar folder tools.";
      case "client-disconnected":
        return "The selected sidebar folder client disconnected.";
      case "busy":
        return "The sidebar folder client is busy. Wait for current calls to finish.";
      case "timeout":
        return "The sidebar folder client did not respond in time. List folders again before retrying.";
      case "not-found":
        return "The sidebar folder was not found in the selected client.";
      case "invalid-response":
        return "The sidebar folder client returned an invalid response.";
    }
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
  threadCount: NonNegativeInt,
  subtreeThreadCount: NonNegativeInt,
  settled: Schema.Boolean,
  routedTickets: NonNegativeInt,
  routedTasks: NonNegativeInt,
});
export type SidebarFolderSummary = typeof SidebarFolderSummary.Type;

export const SidebarFolderAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("list") }),
  Schema.Struct({ type: Schema.Literal("delete"), folderId: TrimmedNonEmptyString }),
]);
export type SidebarFolderAction = typeof SidebarFolderAction.Type;

export const SidebarFolderDeletionResult = Schema.Struct({
  type: Schema.Literal("deleted"),
  deletedFolderIds: Schema.Array(Schema.String),
  releasedThreadCount: NonNegativeInt,
  queuedTicketFolderClears: NonNegativeInt,
  queuedTaskFolderClears: NonNegativeInt,
});

export const SidebarFolderResult = Schema.Union([
  Schema.Struct({ type: Schema.Literal("listed"), folders: Schema.Array(SidebarFolderSummary) }),
  SidebarFolderDeletionResult,
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
