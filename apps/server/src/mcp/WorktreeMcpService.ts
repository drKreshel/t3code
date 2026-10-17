import {
  CommandId,
  MessageId,
  type ProjectId,
  type ThreadId,
  WorktreeMcpFailure,
  type WorktreeMcpContinuationStatus,
  type WorktreeMcpHandoffInput,
  type WorktreeMcpHandoffResult,
  type WorktreeMcpSetupScriptStatus,
  type WorktreeMcpStatusInput,
  type WorktreeMcpStatusResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { classifyProjectCheckout } from "../git/projectWorktree.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import type { McpInvocationScope, McpThreadInvocationScope } from "./McpInvocationContext.ts";

export class WorktreeMcpService extends Context.Service<
  WorktreeMcpService,
  {
    readonly handoff: (
      scope: McpInvocationScope,
      input: WorktreeMcpHandoffInput,
    ) => Effect.Effect<WorktreeMcpHandoffResult, WorktreeMcpFailure>;
    readonly status: (
      scope: McpInvocationScope,
      input: WorktreeMcpStatusInput,
    ) => Effect.Effect<WorktreeMcpStatusResult, WorktreeMcpFailure>;
  }
>()("t3/mcp/WorktreeMcpService") {}

function failure(code: WorktreeMcpFailure["code"], message: string): WorktreeMcpFailure {
  return new WorktreeMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

type HandoffPlan =
  | {
      readonly kind: "create";
      readonly branch: string;
      readonly baseRef: string;
      readonly worktreeBaseRef: string;
      readonly startFromOrigin: boolean;
    }
  | {
      readonly kind: "attach";
      readonly checkout: {
        readonly path: string;
        readonly worktreePath: string | null;
        readonly refName: string;
      };
    };

const asOperationFailed = (prefix: string) =>
  Effect.mapError((error: unknown) =>
    failure("operation_failed", `${prefix}: ${errorMessage(error)}`),
  );

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const setupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

  // Serializes handoffs per thread: two concurrent calls could otherwise both
  // pass the worktreePath === null check and each create a worktree, leaving
  // one untracked on disk.
  const handoffThreadsInFlight = new Set<string>();

  // Worktree tools require a live T3 caller, but may target another thread.
  const requireThreadScope = (scope: McpInvocationScope) =>
    scope.thread === undefined
      ? Effect.fail(
          failure(
            "thread_credential_required",
            "Worktree handoff and status need an agent running inside T3 Code.",
          ),
        )
      : Effect.succeed(scope as McpThreadInvocationScope);

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("worktree")
      ? Effect.void
      : Effect.fail(
          failure("capability_denied", "This MCP credential does not grant worktree capabilities."),
        );

  const loadThread = (threadId: ThreadId) =>
    threadManagement.getThreadRecords(threadId, []).pipe(
      Effect.mapError((error) =>
        error._tag === "OrchestratorProjectionError"
          ? failure("thread_not_found", `Thread '${threadId}' was not found.`)
          : failure(
              "operation_failed",
              `Unable to read thread ${threadId}: ${errorMessage(error)}`,
            ),
      ),
      Effect.filterOrFail(
        (projection) => projection.thread.deletedAt === null,
        () => failure("thread_not_found", `Thread '${threadId}' was not found.`),
      ),
    );

  const loadProject = (threadId: ThreadId, projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      asOperationFailed(`Unable to read project ${projectId}`),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              failure(
                "project_not_found",
                `Project '${projectId}' was not found for thread '${threadId}'.`,
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const readDefaultStartFromOrigin = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.newWorktreesStartFromOrigin),
    asOperationFailed("Unable to read server settings"),
  );

  const handoffIds = (scope: McpThreadInvocationScope) =>
    crypto.randomUUIDv4().pipe(
      Effect.map((uuid) => {
        const part = (kind: string, operation: string) =>
          [kind, "mcp", encodeURIComponent(scope.thread.providerSessionId), operation, uuid].join(
            ":",
          );
        return {
          commandId: CommandId.make(part("command", "worktree-handoff")),
          continuationCommandId: CommandId.make(part("command", "worktree-continuation")),
          continuationMessageId: MessageId.make(part("message", "worktree-continuation")),
        };
      }),
      Effect.orDie,
    );

  // Create mode: resolve the new branch's start point. Only fails before
  // anything is written to disk.
  const planCreate = Effect.fn("WorktreeMcpService.planCreate")(function* (
    projectCwd: string,
    currentBranch: string | null,
    input: WorktreeMcpHandoffInput,
  ) {
    const branch = input.branch;
    if (branch === undefined) {
      return yield* failure(
        "invalid_request",
        "branch is required to create a worktree. To move into an existing worktree, pass attach:true with its path.",
      );
    }

    // Fail fast with an actionable message when the branch already exists:
    // the git driver deliberately keeps stderr out of its errors, so letting
    // `git worktree add` fail would surface only an opaque failure. The
    // existence check uses the complete local branch list (exact match); the
    // paginated substring search only enriches the message with the checkout
    // location when available.
    const localBranchNames = yield* gitWorkflow
      .listLocalBranchNames(projectCwd)
      .pipe(asOperationFailed("Unable to list branches"));
    if (localBranchNames.includes(branch)) {
      const existingRef = yield* gitWorkflow
        .listRefs({ cwd: projectCwd, query: branch, refKind: "local" })
        .pipe(
          Effect.map((result) =>
            result.refs.find((ref) => ref.name === branch && ref.isRemote !== true),
          ),
          Effect.orElseSucceed(() => undefined),
        );
      const checkoutPath = existingRef?.worktreePath ?? null;
      return yield* failure(
        "invalid_request",
        `Branch '${branch}' already exists${
          checkoutPath === null ? "" : ` and is checked out at '${checkoutPath}'`
        }. Choose a different branch name, or delete the existing branch${
          checkoutPath === null ? "" : " and its worktree"
        } first.${checkoutPath === null ? "" : " To move into that worktree instead, pass attach:true with its path."}`,
      );
    }

    let baseRef = input.baseRef;
    if (baseRef === undefined) {
      if (currentBranch === null) {
        return yield* failure(
          "invalid_request",
          "Could not determine the current branch of the project workspace (detached HEAD?). Pass baseRef explicitly.",
        );
      }
      baseRef = currentBranch;
    }

    const startFromOrigin = input.startFromOrigin ?? (yield* readDefaultStartFromOrigin);

    let worktreeBaseRef = baseRef;
    if (startFromOrigin) {
      yield* gitWorkflow
        .fetchRemote({ cwd: projectCwd, remoteName: "origin" })
        .pipe(asOperationFailed("Unable to fetch origin"));
      const resolvedRemoteBase = yield* gitWorkflow
        .resolveRemoteTrackingCommit({
          cwd: projectCwd,
          refName: baseRef,
          fallbackRemoteName: "origin",
        })
        .pipe(asOperationFailed(`Unable to resolve the remote-tracking commit of '${baseRef}'`));
      worktreeBaseRef = resolvedRemoteBase.commitSha;
    }

    return { kind: "create", branch, baseRef, worktreeBaseRef, startFromOrigin } as const;
  });

  // Attach mode: the checkout already exists, typically made by a project's
  // own tooling. It may be the main project checkout, which is represented in
  // thread state by a null worktree path.
  const planAttach = Effect.fn("WorktreeMcpService.planAttach")(function* (
    projectCwd: string,
    input: WorktreeMcpHandoffInput,
  ) {
    const worktreePath = input.path;
    if (worktreePath === undefined) {
      return yield* failure(
        "invalid_request",
        "attach:true needs path, the absolute path of the project's main checkout or an existing worktree. t3_worktree_list shows them.",
      );
    }
    if (input.baseRef !== undefined || input.startFromOrigin !== undefined) {
      return yield* failure(
        "invalid_request",
        "baseRef and startFromOrigin only apply when creating a worktree; omit them with attach:true.",
      );
    }

    const checkout = yield* classifyProjectCheckout(projectCwd, worktreePath).pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, gitDriver),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
    if (checkout === null) {
      return yield* failure(
        "invalid_request",
        `'${worktreePath}' is not the project's main checkout or one of its git worktrees. t3_worktree_list shows them.`,
      );
    }

    // Local status is cached per checkout; read it fresh, since the worktree
    // was usually created or switched just before this call.
    yield* gitWorkflow.invalidateLocalStatus(worktreePath);
    const worktreeStatus = yield* gitWorkflow
      .localStatus({ cwd: worktreePath })
      .pipe(asOperationFailed(`Unable to read git status of '${worktreePath}'`));
    const refName = worktreeStatus.refName;
    if (refName === null) {
      return yield* failure(
        "invalid_request",
        `Checkout '${worktreePath}' has no branch checked out (detached HEAD). Check out a branch there first.`,
      );
    }
    if (input.branch !== undefined && input.branch !== refName) {
      return yield* failure(
        "invalid_request",
        `Checkout '${worktreePath}' has branch '${refName}' checked out, not '${input.branch}'.`,
      );
    }

    return {
      kind: "attach",
      checkout: {
        path: worktreePath,
        worktreePath: checkout === "root" ? null : worktreePath,
        refName,
      },
    } as const;
  });

  const performHandoff = Effect.fn("WorktreeMcpService.performHandoff")(function* (
    scope: McpThreadInvocationScope,
    targetThreadId: ThreadId,
    input: WorktreeMcpHandoffInput,
  ) {
    const workspaceChanged = (worktreePath: string | null) =>
      failure(
        "workspace_changed",
        `Thread '${targetThreadId}' moved to ${
          worktreePath === null ? "the project checkout" : `worktree '${worktreePath}'`
        } while this handoff was in progress.`,
      );

    const projection = yield* loadThread(targetThreadId);
    const previousWorktreePath = projection.thread.worktreePath;
    // An archived thread would accept the binding but refuse the continuation
    // message (and any other follow-up), so reject the handoff outright.
    if (projection.thread.archivedAt !== null) {
      return yield* failure(
        "invalid_request",
        `Thread '${targetThreadId}' is archived and cannot be handed off to another checkout.`,
      );
    }

    const project = yield* loadProject(targetThreadId, projection.thread.projectId);
    const projectCwd = project.workspaceRoot;

    if (input.path !== undefined && !path.isAbsolute(input.path)) {
      return yield* failure(
        "invalid_request",
        `path must be an absolute filesystem path, got '${input.path}'. A relative path would be created relative to the project workspace but stored verbatim as the thread's worktree binding.`,
      );
    }

    const localStatus = yield* gitWorkflow
      .localStatus({ cwd: projectCwd })
      .pipe(asOperationFailed("Unable to read git status"));
    if (!localStatus.isRepo) {
      return yield* failure(
        "invalid_request",
        `Project workspace '${projectCwd}' is not a git repository.`,
      );
    }

    const plan: HandoffPlan =
      input.attach === true
        ? yield* planAttach(projectCwd, input)
        : yield* planCreate(projectCwd, localStatus.refName, input);

    const ids = yield* handoffIds(scope);

    // uninterruptibleMask: only the potentially slow worktree creation itself
    // stays interruptible (restore). From the moment it succeeds, through the
    // binding, continuation queue, setup script launch, and result
    // construction, there is no interruptible gap: a client cancel can
    // therefore neither orphan the created worktree before the rollback is
    // armed, nor skip setting up a worktree the thread was just bound to
    // (once the binding commits, the scheduled session detach can sever this
    // request's connection and interrupt the fiber).
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const checkout =
          plan.kind === "attach"
            ? plan.checkout
            : yield* restore(
                gitWorkflow
                  .createWorktree({
                    cwd: projectCwd,
                    refName: plan.worktreeBaseRef,
                    newRefName: plan.branch,
                    baseRefName: plan.baseRef,
                    path: input.path ?? null,
                  })
                  .pipe(
                    asOperationFailed("Unable to create the worktree"),
                    Effect.map(({ worktree }) => ({
                      path: worktree.path,
                      worktreePath: worktree.path,
                      refName: worktree.refName,
                    })),
                  ),
              );
        const checkoutPath = checkout.path;
        const worktreePath = checkout.worktreePath;

        const reportFailed = (logMessage: string) =>
          Effect.catchCause((cause: Cause.Cause<unknown>) => {
            const detail = errorMessage(Cause.squash(cause));
            return Effect.logWarning(logMessage, {
              threadId: targetThreadId,
              worktreePath,
              detail,
            }).pipe(Effect.as({ status: "failed", detail } as const));
          });

        const removeCreatedWorktree = Effect.suspend(() =>
          gitWorkflow.removeWorktree({ cwd: projectCwd, path: checkoutPath, force: true }).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                gitWorkflow.deleteLocalBranch({
                  cwd: projectCwd,
                  refName: checkout.refName,
                  force: true,
                }),
              ),
            ),
          ),
        ).pipe(Effect.ignoreCause({ log: true }));

        const recheckAndBind = Effect.gen(function* () {
          // The projection was read before the potentially slow git work
          // above; a concurrent binding (for example from the UI) could have
          // attached the thread in the meantime. Re-check before committing so
          // the race cannot leave a second, untracked worktree.
          const recheck = yield* loadThread(targetThreadId);
          if (recheck.thread.worktreePath !== previousWorktreePath) {
            return yield* workspaceChanged(recheck.thread.worktreePath);
          }
          if (recheck.thread.archivedAt !== null) {
            return yield* failure(
              "invalid_request",
              plan.kind === "attach"
                ? `Thread '${targetThreadId}' was archived during the handoff; its workspace was not changed.`
                : `Thread '${targetThreadId}' was archived while the worktree was being created; the handoff was rolled back.`,
            );
          }
          yield* threadManagement
            .dispatch({
              type: "thread.metadata.update",
              commandId: ids.commandId,
              threadId: targetThreadId,
              branch: checkout.refName,
              worktreePath,
              expectedWorktreePath: previousWorktreePath,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause as Cause.Cause<never>)
                  : Effect.fail(
                      failure(
                        "operation_failed",
                        `Unable to re-point the thread at the target checkout: ${errorMessage(Cause.squash(cause))}`,
                      ),
                    ),
              ),
            );
        }).pipe(
          // onError: the worktree was already created, so any failure between
          // here and the committed binding (recheck read, recheck race,
          // dispatch typed failure or defect) must remove it again so a failed
          // handoff leaves nothing behind on disk. Interrupt-only causes skip
          // the removal: the binding may have committed, and force-deleting a
          // worktree the thread now points at would be worse than leaking one.
          // An attached checkout belongs to whoever created it and is never
          // removed: a failed attach leaves the thread on its prior checkout.
          Effect.onError((cause) =>
            plan.kind === "attach" || Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : removeCreatedWorktree,
          ),
        );

        // Queue the continuation right after the binding commits: the detach
        // that the metadata update schedules will terminate the target
        // session, and a durably queued message is what guarantees the thread
        // re-launches inside the checkout. When the dying run reaches a
        // terminal state the orchestrator promotes the queued run, which
        // derives its cwd from the updated projection.
        // suspend: build the send effect only when the binding has succeeded,
        // so a failed dispatch never even constructs the continuation call.
        const queueContinuation: Effect.Effect<WorktreeMcpContinuationStatus, WorktreeMcpFailure> =
          Effect.suspend(() =>
            input.continuationPrompt === undefined
              ? Effect.succeed<WorktreeMcpContinuationStatus>({ status: "skipped" })
              : threadManagement
                  .sendToThread({
                    projectId: projection.thread.projectId,
                    commandId: ids.continuationCommandId,
                    threadId: targetThreadId,
                    messageId: ids.continuationMessageId,
                    text: input.continuationPrompt,
                    attachments: [],
                    mode: "queue",
                    createdBy: "agent",
                    creationSource: "mcp",
                  })
                  .pipe(
                    Effect.map((sendResult): WorktreeMcpContinuationStatus => ({
                      status: "scheduled",
                      delivery: sendResult.delivery,
                    })),
                    reportFailed("worktree handoff continuation failed to queue"),
                  ),
          );

        const continuation = yield* recheckAndBind.pipe(Effect.andThen(queueContinuation));

        yield* vcsStatusBroadcaster
          .refreshStatus(checkoutPath)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);

        let setupScript: WorktreeMcpSetupScriptStatus = { status: "skipped" };
        // An attached checkout was set up by whoever created it.
        if (input.runSetupScript ?? plan.kind === "create") {
          setupScript = yield* setupScriptRunner
            .runForThread({
              threadId: targetThreadId,
              projectId: projection.thread.projectId,
              projectCwd,
              worktreePath: checkoutPath,
              project: {
                id: project.id,
                workspaceRoot: project.workspaceRoot,
                scripts: project.scripts,
              },
            })
            .pipe(
              Effect.map((result): WorktreeMcpSetupScriptStatus =>
                result.status === "started"
                  ? {
                      status: "started",
                      scriptName: result.scriptName,
                      terminalId: result.terminalId,
                    }
                  : { status: "no-script" },
              ),
              reportFailed("worktree handoff setup script failed"),
            );
        }

        const previousCheckoutNote =
          previousWorktreePath !== null && previousWorktreePath !== worktreePath
            ? ` The previous worktree '${previousWorktreePath}' was not removed.`
            : "";
        const result: WorktreeMcpHandoffResult = {
          threadId: targetThreadId,
          worktreePath,
          branch: checkout.refName,
          baseRef: plan.kind === "create" ? plan.baseRef : null,
          startedFromOrigin: plan.kind === "create" && plan.startFromOrigin,
          setupScript,
          continuation,
          note:
            targetThreadId === scope.thread.threadId
              ? continuation.status === "scheduled"
                ? `Handoff recorded. Changing this thread's workspace detaches its provider session, so the current turn ends shortly after this call; the queued continuation starts the next turn in the target checkout with the conversation preserved.${previousCheckoutNote}`
                : `Handoff recorded. Changing this thread's workspace detaches its provider session, so the current turn ends shortly after this call; the conversation continues in the target checkout when the thread receives its next message. Pass continuationPrompt to resume automatically.${previousCheckoutNote}`
              : continuation.status === "scheduled"
                ? `Handoff recorded for thread '${targetThreadId}'. Any live provider session in that thread was detached, and the queued continuation will resume it in the target checkout.${previousCheckoutNote}`
                : `Handoff recorded for thread '${targetThreadId}'. Any live provider session in that thread was detached; it will use the target checkout when it next receives a message.${previousCheckoutNote}`,
        };
        return result;
      }),
    );
  });

  const handoff: WorktreeMcpService["Service"]["handoff"] = Effect.fn("WorktreeMcpService.handoff")(
    function* (callerScope, input) {
      yield* requireCapability(callerScope);
      const scope = yield* requireThreadScope(callerScope);
      const targetThreadId = input.threadId ?? scope.thread.threadId;
      // uninterruptibleMask: the guard acquisition and the registration of the
      // releasing finalizer happen with no interruptible gap in between. An
      // interrupt landing between a bare add() and the start of an ensured
      // effect would otherwise leak the guard entry and block every future
      // handoff for the target thread until restart.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          if (handoffThreadsInFlight.has(targetThreadId)) {
            return Effect.fail(
              failure(
                "handoff_in_progress",
                `A worktree handoff is already in progress for thread '${targetThreadId}'.`,
              ),
            );
          }
          handoffThreadsInFlight.add(targetThreadId);
          return restore(performHandoff(scope, targetThreadId, input)).pipe(
            Effect.ensuring(Effect.sync(() => handoffThreadsInFlight.delete(targetThreadId))),
          );
        }),
      );
    },
  );

  const status: WorktreeMcpService["Service"]["status"] = Effect.fn("WorktreeMcpService.status")(
    function* (callerScope, input) {
      yield* requireCapability(callerScope);
      const scope = yield* requireThreadScope(callerScope);
      const targetThreadId = input.threadId ?? scope.thread.threadId;
      const projection = yield* loadThread(targetThreadId);
      const project = yield* loadProject(targetThreadId, projection.thread.projectId);

      const defaultStartFromOrigin = yield* readDefaultStartFromOrigin;

      const result: WorktreeMcpStatusResult = {
        threadId: targetThreadId,
        attached: projection.thread.worktreePath !== null,
        worktreePath: projection.thread.worktreePath,
        branch: projection.thread.branch,
        projectWorkspaceRoot: project.workspaceRoot,
        defaultStartFromOrigin,
      };
      return result;
    },
  );

  return WorktreeMcpService.of({ handoff, status });
});

export const layer: Layer.Layer<
  WorktreeMcpService,
  never,
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ThreadManagementService.ThreadManagementService
  | ProjectService.ProjectService
  | ServerSettings.ServerSettingsService
  | GitWorkflowService.GitWorkflowService
  | GitVcsDriver.GitVcsDriver
  | ProjectSetupScriptRunner.ProjectSetupScriptRunner
  | VcsStatusBroadcaster.VcsStatusBroadcaster
> = Layer.effect(WorktreeMcpService, make);
