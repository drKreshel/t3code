import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Input for the `t3_worktree_handoff` MCP tool: creates a worktree, or with `attach` binds an
 * existing project checkout, for this or another thread. Changing a workspace detaches that
 * thread's live provider session; a continuation can resume it in the target checkout.
 */
export const WorktreeMcpHandoffInput = Schema.Struct({
  threadId: Schema.optional(
    ThreadId.annotate({ description: "Thread to move. Default: this thread." }),
  ),
  attach: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Attach the existing checkout at `path` (the project root or one of its worktrees) instead of creating one. Never removes a checkout.",
    }),
  ),
  branch: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "New branch name. Required unless `attach`; when attaching, must match the checked-out branch.",
    }),
  ),
  baseRef: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Default: checked-out branch.",
    }),
  ),
  startFromOrigin: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "True: fetch, start from the remote ref; check `startedFromOrigin`. Default: server setting.",
    }),
  ),
  path: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isPattern(/^(?:[A-Za-z]:[\\/]|[\\/])/)).annotate({
      description:
        "Absolute filesystem path of the target checkout. Relative paths are rejected. Required when attaching. Ignored when creating: new worktrees always go in the server-managed worktrees directory.",
    }),
  ),
  runSetupScript: Schema.optional(
    Schema.Boolean.annotate({
      description: "Default true for a new worktree, false when attaching.",
    }),
  ),
  continuationPrompt: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
      description: "Work to resume in the target checkout next turn. Omitted: thread waits.",
    }),
  ),
});
export type WorktreeMcpHandoffInput = typeof WorktreeMcpHandoffInput.Type;

export const WorktreeMcpSetupScriptStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("started"),
    scriptName: TrimmedNonEmptyString,
    terminalId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("no-script"),
  }),
  Schema.Struct({
    status: Schema.Literal("skipped"),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    detail: Schema.String,
  }),
]);
export type WorktreeMcpSetupScriptStatus = typeof WorktreeMcpSetupScriptStatus.Type;

export const WorktreeMcpContinuationStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("scheduled"),
    delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
  }),
  Schema.Struct({
    status: Schema.Literal("skipped"),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    detail: Schema.String,
  }),
]);
export type WorktreeMcpContinuationStatus = typeof WorktreeMcpContinuationStatus.Type;

export const WorktreeMcpHandoffResult = Schema.Struct({
  threadId: ThreadId,
  /** Null means the thread now uses the project's main checkout. */
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  branch: TrimmedNonEmptyString,
  /** Null when an existing checkout was attached. */
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  startedFromOrigin: Schema.Boolean,
  setupScript: WorktreeMcpSetupScriptStatus,
  continuation: WorktreeMcpContinuationStatus,
  note: Schema.String,
});
export type WorktreeMcpHandoffResult = typeof WorktreeMcpHandoffResult.Type;

export const WorktreeMcpStatusInput = Schema.Struct({
  threadId: Schema.optional(
    ThreadId.annotate({
      description: "Thread to inspect. Defaults to the calling thread.",
    }),
  ),
});
export type WorktreeMcpStatusInput = typeof WorktreeMcpStatusInput.Type;

export const WorktreeMcpStatusResult = Schema.Struct({
  threadId: ThreadId,
  attached: Schema.Boolean,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  projectWorkspaceRoot: TrimmedNonEmptyString,
  defaultStartFromOrigin: Schema.Boolean.annotate({
    description: "`startFromOrigin` default for `t3_worktree_handoff`.",
  }),
});
export type WorktreeMcpStatusResult = typeof WorktreeMcpStatusResult.Type;

export class WorktreeMcpFailure extends Schema.TaggedError<WorktreeMcpFailure>()(
  "WorktreeMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "thread_not_found",
      "project_not_found",
      "already_in_worktree",
      "workspace_changed",
      "handoff_in_progress",
      "invalid_request",
      "operation_failed",
      "thread_credential_required",
    ]),
    message: Schema.String,
  },
) {}
