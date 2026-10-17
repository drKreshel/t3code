import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Input for the `t3_worktree_handoff` MCP tool.
 *
 * Creates a git worktree for a thread, or with `attach` binds one of the
 * project's existing checkouts, and re-points the thread at it. Omitting
 * `threadId` targets the calling thread. Changing a workspace detaches that
 * thread's live provider session; a continuation can resume it in the target
 * checkout.
 */
export const WorktreeMcpHandoffInput = Schema.Struct({
  threadId: Schema.optional(
    ThreadId.annotate({
      description:
        "Thread to move. Defaults to the calling thread. The target may already be attached to another worktree.",
    }),
  ),
  attach: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Attach the existing checkout at path instead of creating a worktree. The path must be the project's main checkout or one of its git worktrees, with a branch checked out. Passing the main checkout moves the thread back to the project root. T3 never removes the attached checkout or the thread's previous worktree. baseRef and startFromOrigin do not apply.",
    }),
  ),
  branch: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Branch name to create for the worktree (e.g. 'feature/my-change'). Required unless attach is set; when attaching, it must match the worktree's checked-out branch.",
    }),
  ),
  baseRef: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Branch or ref the worktree branch starts from. Defaults to the branch currently checked out in the project workspace.",
    }),
  ),
  startFromOrigin: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Fetch origin and start the worktree branch from the remote-tracking commit of baseRef instead of the local ref. Defaults to the server's 'new worktrees start from origin' setting.",
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
      description:
        "Run the project's configured setup script in the target checkout after handoff. Defaults to true when creating a worktree and false when attaching an existing checkout.",
    }),
  ),
  continuationPrompt: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
      description:
        "Message queued as the target thread's next turn after the handoff. The handoff detaches that thread's current provider session, so pass the remaining work here to automatically resume in the target checkout; omit it to leave the thread idle until its next message.",
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
  attached: Schema.Boolean.annotate({
    description: "True when the target thread is attached to a git worktree.",
  }),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  projectWorkspaceRoot: TrimmedNonEmptyString.annotate({
    description: "Root of the project's main workspace checkout.",
  }),
  defaultStartFromOrigin: Schema.Boolean.annotate({
    description: "Server default used by t3_worktree_handoff when startFromOrigin is omitted.",
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
