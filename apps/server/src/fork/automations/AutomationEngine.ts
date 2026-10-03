/**
 * Scheduled automations and explicitly started ticket workflows share a runner.
 * A workflow owns one durable chat; Resume dispatches its next turn there.
 * Starts and lifecycle events are serialized so concurrent requests cannot
 * create duplicate execution on a ticket.
 */
import {
  AutomationsCommandError,
  type AutomationsCommand,
  type AutomationsCommandResult,
  type BoardsSnapshot,
  CommandId,
  DEFAULT_MODEL,
  MessageId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type Ticket,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { forkParked } from "../../serverActivation.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { BoardsService } from "../boards/BoardsService.ts";
import {
  decideSchedule,
  nextScheduledAt,
  renderPrompt,
  scheduleProblem,
  stepsProblem,
} from "./automationLogic.ts";
import { AutomationsStore, type StoredAutomation } from "./AutomationsStore.ts";
import { workflowPrompt } from "./workflowLogic.ts";
import { TicketWorkspaces } from "../workspaces/TicketWorkspaces.ts";

const SCHEDULER_TICK = "20 seconds";

export class AutomationEngine extends Context.Service<
  AutomationEngine,
  {
    readonly dispatch: (
      command: AutomationsCommand,
    ) => Effect.Effect<AutomationsCommandResult, AutomationsCommandError>;
    /** What the background loops call per event; tests call them directly. */
    readonly handleDomainEvent: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly tick: Effect.Effect<void>;
  }
>()("t3/fork/automations/AutomationEngine") {}

const invalid = (message: string) => new AutomationsCommandError({ code: "invalid", message });

/** Why a run could not start; becomes the run's reason. */
class RunStartError extends Data.TaggedError("RunStartError")<{ readonly message: string }> {}

const make = (options: { readonly background: boolean }) =>
  Effect.gen(function* () {
    const store = yield* AutomationsStore;
    const boards = yield* BoardsService;
    const orchestration = yield* Orchestrator.OrchestratorV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const git = yield* GitWorkflowService.GitWorkflowService;
    const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
    const crypto = yield* Crypto.Crypto;
    const lock = yield* Semaphore.make(1);
    // Optional, so runtimes without ticket workspaces (tests) still build.
    const workspaces = yield* Effect.serviceOption(TicketWorkspaces);

    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
    const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect);
    const actorOf = (automation: { readonly id: string }) => `automation:${automation.id}`;

    const boardsSnapshot = boards.snapshot.pipe(
      Effect.mapError((error) => new RunStartError({ message: error.message })),
    );

    const ticketLabel = (snapshot: BoardsSnapshot, ticket: Ticket) => {
      const board = snapshot.boards.find((candidate) => candidate.id === ticket.boardId);
      return `${board?.key ?? "?"}-${ticket.number}`;
    };

    /** Flags a ticket for a person after a failed or paused turn. */
    const escalate = (
      ticketId: string,
      reason: string,
      actor: string,
      level: "warning" | "error",
    ) =>
      Effect.gen(function* () {
        yield* boards.dispatch({ type: "ticket.flag", ticketId, level, reason }, actor);
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Automation could not escalate ticket", { error }),
        ),
      );

    const defaultModel = (projectId: ProjectId) =>
      Effect.gen(function* () {
        const settings = yield* settingsService.getSettings;
        const project = yield* projects.getShell(projectId).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.orElseSucceed(() => undefined),
        );
        const fallback: ModelSelection = settings.defaultModelSelection ?? {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        };
        return (
          resolveProjectSettings(settings, projectId, project).settings.defaultModelSelection ??
          fallback
        );
      }).pipe(
        Effect.mapError(
          () => new RunStartError({ message: "Could not read the server settings." }),
        ),
      );

    /** Scheduled cleanup steps run in order; the first failure stops the rest. */
    const runSteps = (automation: StoredAutomation, snapshot: BoardsSnapshot) =>
      Effect.gen(function* () {
        const actor = actorOf(automation);
        const asStepError = (error: { readonly message: string }) =>
          new RunStartError({ message: error.message });
        for (const step of automation.action.steps ?? []) {
          if (step.type !== "moveStale" || automation.trigger.type !== "schedule") {
            return yield* new RunStartError({
              message: "Ticket actions belong in workflow instructions.",
            });
          }
          const cutoff =
            DateTime.toEpochMillis(yield* DateTime.now) - step.olderThanDays * 24 * 60 * 60 * 1000;
          for (const board of snapshot.boards) {
            if (board.archivedAt !== null) continue;
            if (step.boardId && step.boardId !== board.id) continue;
            const named = (name: string) =>
              board.columns.find(
                (column) => column.name.trim().toLowerCase() === name.trim().toLowerCase(),
              );
            const from = named(step.from);
            const to = named(step.to);
            if (!from || !to || from.id === to.id) continue;
            for (const stale of snapshot.tickets) {
              if (stale.columnId !== from.id || stale.archivedAt !== null) continue;
              if (DateTime.toEpochMillis(DateTime.makeUnsafe(stale.updatedAt)) > cutoff) continue;
              yield* boards
                .dispatch({ type: "ticket.move", ticketId: stale.id, columnId: to.id }, actor)
                .pipe(Effect.mapError(asStepError));
            }
          }
        }
      });

    const startRun = (
      automation: StoredAutomation,
      runId: string,
      ticketId: string | null,
      resumeThreadId?: ThreadId,
    ) =>
      Effect.gen(function* () {
        const snapshot = yield* boardsSnapshot;
        const ticket =
          ticketId === null ? undefined : snapshot.tickets.find((t) => t.id === ticketId);
        if (ticketId !== null && !ticket)
          return yield* new RunStartError({ message: "The ticket no longer exists." });
        if (automation.action.steps && automation.action.steps.length > 0) {
          const startedAt = yield* nowIso;
          yield* store.updateRun(runId, { status: "running", startedAt });
          yield* runSteps(automation, snapshot);
          yield* store.updateRun(runId, { status: "succeeded", finishedAt: yield* nowIso });
          return;
        }
        const board = ticket ? snapshot.boards.find((b) => b.id === ticket.boardId) : undefined;

        // In the ticket's workspace the chat belongs to the ticket's project.
        const projectKey =
          automation.action.checkout === "ticket"
            ? (ticket?.projectKey ?? board?.defaultProjectKey ?? automation.action.projectKey)
            : (automation.action.projectKey ??
              ticket?.projectKey ??
              board?.defaultProjectKey ??
              null);
        if (projectKey === null) {
          return yield* new RunStartError({
            message:
              "No project to start the chat in: set one on the automation, the ticket, or the board.",
          });
        }
        const separator = projectKey.indexOf(":");
        if (projectKey.slice(0, separator) !== environmentId) {
          return yield* new RunStartError({ message: "The project is on another environment." });
        }
        const projectId = ProjectId.make(projectKey.slice(separator + 1));
        const project = yield* projects.getShell(projectId).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.orElseSucceed(() => undefined),
        );
        if (!project) return yield* new RunStartError({ message: "The project no longer exists." });

        const modelSelection = automation.action.modelSelection ?? (yield* defaultModel(projectId));

        let branch: string | null = null;
        let worktreePath: string | null = null;
        // A new ticket workspace runs the project's setup script once the chat exists.
        let setUpWorkspace = false;
        if (resumeThreadId === undefined && automation.action.checkout === "ticket") {
          if (!ticket) {
            return yield* new RunStartError({
              message: "A ticket workflow is required to use a ticket's workspace.",
            });
          }
          if (Option.isNone(workspaces)) {
            return yield* new RunStartError({
              message: "Ticket workspaces are not available on this server.",
            });
          }
          const workspace = yield* workspaces.value
            .dispatch({ type: "workspace.ensure", ticketId: ticket.id })
            .pipe(
              // A ticket set to work in the project checkout runs there.
              Effect.catchIf(
                (error) => error.code === "no-workspace",
                () => Effect.succeed(null),
              ),
              Effect.mapError((error) => new RunStartError({ message: error.message })),
            );
          if (workspace !== null) {
            worktreePath = workspace.path;
            branch = workspace.branch;
            setUpWorkspace = workspace.created;
          }
        } else if (resumeThreadId === undefined && automation.action.checkout === "worktree") {
          const token = (yield* uuid).replaceAll("-", "");
          const created = yield* git
            .createWorktree({
              cwd: project.workspaceRoot,
              refName: "HEAD",
              newRefName: buildTemporaryWorktreeBranchName(() => token),
              path: null,
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new RunStartError({ message: `Could not create a worktree: ${error.message}` }),
              ),
            );
          branch = created.worktree.refName;
          worktreePath = created.worktree.path;
        }

        const priorRuns = ticketId === null ? [] : yield* store.runsForTicket(ticketId);
        const runNumber =
          priorRuns.filter((run) => run.automationId === automation.id && run.startedAt !== null)
            .length + 1;
        let handoff: string | null = null;
        if (ticket) {
          const detail = yield* Stream.runHead(boards.ticketDetailStream(ticket.id)).pipe(
            Effect.orElseSucceed(() => Option.none()),
          );
          handoff = Option.match(detail, {
            onNone: () => null,
            onSome: (value) =>
              value.comments.toReversed().find((comment) => comment.isHandoff)?.body ?? null,
          });
        }
        const renderedPrompt = renderPrompt(automation.prompt, {
          ...(ticket
            ? {
                ticket: {
                  key: ticketLabel(snapshot, ticket),
                  ticket,
                  boardName: board?.name ?? "",
                  handoff,
                },
              }
            : {}),
          runNumber,
        });

        const text =
          automation.trigger.type === "workflow"
            ? `Ticket ${ticket ? ticketLabel(snapshot, ticket) : ""}\n\n${workflowPrompt(renderedPrompt, resumeThreadId !== undefined)}`
            : renderedPrompt;
        const threadId = resumeThreadId ?? ThreadId.make(yield* uuid);
        const createdAt = yield* nowIso;
        const title = ticket
          ? `${ticketLabel(snapshot, ticket)} · ${automation.title}`
          : automation.title;
        const dispatchFailed = (error: unknown) =>
          new RunStartError({
            message: `Could not start the chat: ${error instanceof Error ? error.message : String(error)}`,
          });
        if (resumeThreadId === undefined)
          yield* orchestration
            .dispatch({
              type: "thread.create",
              commandId: CommandId.make(`server:automation-thread:${yield* uuid}`),
              threadId,
              projectId,
              title,
              modelSelection,
              runtimeMode: automation.action.runtimeMode,
              interactionMode: automation.action.interactionMode,
              branch,
              worktreePath,
              createdBy: "system",
              creationSource: "server",
            })
            .pipe(Effect.mapError(dispatchFailed));
        const threadKey = `${environmentId}:${threadId}`;
        // Recorded before the turn starts, so a turn that ends at once is still matched.
        yield* store.updateRun(runId, { status: "running", threadKey, startedAt: createdAt });
        if (ticket) {
          yield* boards
            .dispatch(
              automation.trigger.type === "workflow"
                ? {
                    type: "ticket.workflowSession",
                    ticketId: ticket.id,
                    threadKey,
                    event: resumeThreadId === undefined ? "started" : "resumed",
                  }
                : { type: "thread.link", threadKey, ticketId: ticket.id },
              actorOf(automation),
            )
            .pipe(Effect.mapError(dispatchFailed));
        }
        if (setUpWorkspace && ticket && Option.isSome(workspaces)) {
          yield* workspaces.value
            .dispatch({ type: "workspace.setup", ticketId: ticket.id, threadId })
            .pipe(Effect.ignore);
        }
        yield* orchestration
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`server:automation-turn:${yield* uuid}`),
            threadId,
            messageId: MessageId.make(yield* uuid),
            text,
            attachments: [],
            createdBy: "system",
            creationSource: "server",
            dispatchMode: { type: "start_immediately" },
          })
          .pipe(Effect.mapError(dispatchFailed));
      }).pipe(
        Effect.catchTag("RunStartError", (error) =>
          failRun(automation, runId, ticketId, error.message),
        ),
        Effect.catch((error) =>
          failRun(
            automation,
            runId,
            ticketId,
            error instanceof Error ? error.message : "The run could not start.",
          ),
        ),
      );

    const failRun = (
      automation: Pick<StoredAutomation, "id" | "title" | "trigger">,
      runId: string,
      ticketId: string | null,
      reason: string,
    ) =>
      Effect.gen(function* () {
        yield* store.updateRun(runId, { status: "failed", reason, finishedAt: yield* nowIso });
        if (ticketId !== null) {
          yield* escalate(
            ticketId,
            `"${automation.title}" failed: ${reason}`,
            actorOf(automation),
            "error",
          );
          if (automation.trigger.type === "workflow") {
            const ticket = (yield* boards.snapshot).tickets.find(
              (candidate) => candidate.id === ticketId,
            );
            const run = (yield* store.runsForTicket(ticketId)).find(
              (candidate) => candidate.id === runId,
            );
            yield* boards.dispatch(
              {
                type: "ticket.workflowSession",
                ticketId,
                threadKey: run?.threadKey ?? ticket?.workflowThreadKey ?? null,
                event: "failed",
                reason,
              },
              actorOf(automation),
            );
          }
        }
      }).pipe(
        Effect.catch((error) => Effect.logWarning("Could not record a failed run", { error })),
      );

    /** Deletion clears execution ownership even after the last turn finished. */
    const settleDeleted = (threadKey: string) =>
      Effect.gen(function* () {
        const run = yield* store.runningRunForThread(threadKey);
        if (Option.isSome(run))
          yield* store.updateRun(run.value.id, {
            status: "failed",
            reason: "The chat was deleted.",
            finishedAt: yield* nowIso,
          });
        const ticket = (yield* boards.snapshot).tickets.find((candidate) =>
          candidate.threadKeys.includes(threadKey),
        );
        if (!ticket) return;
        if (ticket.workflowThreadKey === threadKey)
          yield* boards.dispatch(
            {
              type: "ticket.workflowSession",
              ticketId: ticket.id,
              threadKey: null,
              event: "failed",
              reason: "The workflow session was deleted. Start again to create a new session.",
            },
            "system",
          );
        yield* boards.dispatch({ type: "thread.link", threadKey, ticketId: null }, "system");
      });

    /** A chat's turn ended (or never started): settle its run. */
    const settleThread = (threadKey: string, failure: string | null) =>
      Effect.gen(function* () {
        const run = yield* store.runningRunForThread(threadKey);
        if (Option.isNone(run)) return;
        let outcome: { readonly status: "succeeded" | "failed"; readonly reason: string | null };
        if (failure !== null) {
          outcome = { status: "failed", reason: failure };
        } else {
          const threadId = ThreadId.make(threadKey.slice(threadKey.indexOf(":") + 1));
          const found = yield* orchestration.getThreadShell(threadId).pipe(Effect.option);
          // Unreadable: try again on the next event. Missing: deleted while the server was off.
          if (Option.isNone(found)) return;
          if (found.value === null) return yield* settleDeleted(threadKey);
          const shell = found.value;
          const state = shell.status;
          if (
            state !== "completed" &&
            state !== "failed" &&
            state !== "interrupted" &&
            state !== "cancelled" &&
            state !== "rolled_back"
          )
            return;
          outcome =
            state === "completed"
              ? { status: "succeeded", reason: null }
              : state === "interrupted"
                ? { status: "failed", reason: "The chat was stopped." }
                : {
                    status: "failed",
                    reason: shell.lastError ?? "The chat's turn failed.",
                  };
        }
        const automation = yield* store.get(run.value.automationId).pipe(Effect.option);
        if (outcome.status === "failed" && Option.isSome(automation)) {
          yield* failRun(automation.value, run.value.id, run.value.ticketId, outcome.reason ?? "");
        } else {
          yield* store.updateRun(run.value.id, {
            status: outcome.status,
            reason: outcome.reason,
            finishedAt: yield* nowIso,
          });
          if (run.value.ticketId !== null) {
            const ticket = (yield* boards.snapshot).tickets.find(
              (candidate) => candidate.id === run.value.ticketId,
            );
            if (ticket?.workflowThreadKey === threadKey)
              yield* boards.dispatch(
                {
                  type: "ticket.workflowSession",
                  ticketId: ticket.id,
                  threadKey,
                  event: "finished",
                },
                "system",
              );
          }
        }
      });

    /** One scheduler pass: fire due schedules, record missed ones. */
    const tick = Effect.gen(function* () {
      const now = yield* DateTime.now;
      for (const automation of yield* store.list) {
        if (!automation.enabled || automation.trigger.type !== "schedule") continue;
        const due = nextScheduledAt(
          automation.trigger,
          DateTime.makeUnsafe(automation.lastFiredAt ?? automation.createdAt),
          automation.lastFiredAt !== null,
        );
        const decision = decideSchedule(due, now);
        if (decision === "wait") continue;
        const at = DateTime.formatIso(now);
        yield* store.markFired(automation.id, at);
        if (decision === "missed") {
          yield* store.insertRun({
            automationId: automation.id,
            ticketId: null,
            status: "missed",
            reason: `T3 Code was not running at ${due ? DateTime.formatIso(due) : "the scheduled time"}.`,
          });
          continue;
        }
        const runId = yield* store.insertRun({
          automationId: automation.id,
          ticketId: null,
          status: "queued",
        });
        yield* startRun(automation, runId, null);
      }
    });

    /** Runs left `running` while the server was off may have finished meanwhile. */
    const reconcile = Effect.gen(function* () {
      for (const run of yield* store.runsWithStatus("running")) {
        if (run.threadKey !== null) yield* settleThread(run.threadKey, null);
      }
    });

    const logged = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => Effect.logWarning(`Automation ${label} failed`, { cause })),
      );

    const handleDomainEvent = (event: OrchestrationV2DomainEvent) => {
      if (event.type === "thread.created" && event.payload.lineage.parentThreadId !== null) {
        const parentKey = `${environmentId}:${event.payload.lineage.parentThreadId}`;
        return logged(
          "workflow delegation",
          serialized(
            Effect.gen(function* () {
              const snapshot = yield* boards.snapshot;
              const childKey = `${environmentId}:${event.threadId}`;
              if (snapshot.tickets.some((candidate) => candidate.threadKeys.includes(childKey)))
                return;
              const ticket = snapshot.tickets.find((candidate) =>
                candidate.threadKeys.includes(parentKey),
              );
              if (!ticket?.workflow) return;
              yield* boards.dispatch(
                {
                  type: "thread.link",
                  ticketId: ticket.id,
                  threadKey: `${environmentId}:${event.threadId}`,
                },
                `thread:${parentKey}`,
              );
            }),
          ),
        );
      }
      if (event.type === "thread.deleted") {
        return logged(
          "chat deletion",
          serialized(settleDeleted(`${environmentId}:${event.threadId}`)),
        );
      }
      if (event.type === "run.updated") {
        const status = event.payload.status;
        if (
          status === "completed" ||
          status === "failed" ||
          status === "interrupted" ||
          status === "cancelled" ||
          status === "rolled_back"
        ) {
          return logged(
            "turn end",
            serialized(settleThread(`${environmentId}:${event.threadId}`, null)),
          );
        }
      }
      return Effect.void;
    };

    const scheduledTick = logged("scheduler", serialized(tick));

    if (options.background) {
      const domainEvents = orchestration.streamDomainEvents;
      yield* forkParked(
        Effect.gen(function* () {
          yield* logged("reconcile", serialized(reconcile));
          yield* Effect.forkScoped(
            scheduledTick.pipe(Effect.repeat(Schedule.spaced(SCHEDULER_TICK))),
          );
          yield* Stream.runForEach(domainEvents, handleDomainEvent);
        }),
      );
    }

    const dispatch = (command: AutomationsCommand) =>
      serialized(
        Effect.gen(function* () {
          switch (command.type) {
            case "automation.create": {
              if (command.trigger.type === "board")
                return yield* invalid("Column hooks have been replaced by ticket workflows.");
              const problem = scheduleProblem(command.trigger);
              if (problem) return yield* invalid(problem);
              const actionProblem = stepsProblem(command.trigger, command.action, command.prompt);
              if (actionProblem) return yield* invalid(actionProblem);
              const runsSteps = (command.action.steps?.length ?? 0) > 0;
              if (
                !runsSteps &&
                command.trigger.type === "schedule" &&
                command.action.projectKey === null
              ) {
                return yield* invalid("A scheduled automation needs a project.");
              }
              if (command.trigger.type === "schedule" && command.action.checkout === "ticket") {
                return yield* invalid(
                  "A scheduled automation has no ticket, so it cannot use a ticket's workspace.",
                );
              }
              const id = yield* store.create({
                title: command.title,
                prompt: command.prompt,
                trigger: command.trigger,
                action: command.action,
                enabled: command.enabled ?? true,
                // Retained for compatibility with historical hook records.
                maxRunsPerTicket: command.maxRunsPerTicket ?? 5,
              });
              return { id };
            }
            case "automation.update": {
              const current = yield* store.get(command.automationId);
              const stepProblem = stepsProblem(
                command.trigger ?? current.trigger,
                command.action ?? current.action,
                command.prompt ?? current.prompt,
              );
              if (stepProblem) return yield* invalid(stepProblem);
              if (command.trigger) {
                if (command.trigger.type === "board")
                  return yield* invalid("Column hooks have been replaced by ticket workflows.");
                const problem = scheduleProblem(command.trigger);
                if (problem) return yield* invalid(problem);
              }
              yield* store.update(command.automationId, {
                ...(command.title !== undefined ? { title: command.title } : {}),
                ...(command.prompt !== undefined ? { prompt: command.prompt } : {}),
                ...(command.trigger !== undefined ? { trigger: command.trigger } : {}),
                ...(command.action !== undefined ? { action: command.action } : {}),
                ...(command.enabled !== undefined ? { enabled: command.enabled } : {}),
                ...(command.maxRunsPerTicket !== undefined
                  ? { maxRunsPerTicket: command.maxRunsPerTicket }
                  : {}),
              });
              return { id: null };
            }
            case "ticket.startWorkflow": {
              const snapshot = yield* boards.snapshot.pipe(
                Effect.mapError((error) => invalid(error.message)),
              );
              const ticket = snapshot.tickets.find(
                (candidate) => candidate.id === command.ticketId,
              );
              if (
                !ticket ||
                ticket.archivedAt !== null ||
                snapshot.boards.find((board) => board.id === ticket.boardId)?.archivedAt !== null
              ) {
                return yield* invalid("Choose an active ticket to start.");
              }
              if (!ticket.workflow) return yield* invalid("Choose a workflow on the ticket first.");
              const problem = stepsProblem(
                { type: "workflow" },
                ticket.workflow.action,
                ticket.workflow.prompt,
              );
              if (problem) return yield* invalid(problem);
              for (const run of yield* store.runsForTicket(ticket.id)) {
                if (run.status === "running" && run.threadKey !== null) {
                  yield* settleThread(run.threadKey, null);
                }
              }
              if ((yield* store.runsForTicket(ticket.id)).some((run) => run.status === "running")) {
                return yield* invalid(
                  "A session is already working on this ticket. Open that chat to follow its progress.",
                );
              }
              let resumeThreadId: ThreadId | undefined;
              for (const key of ticket.threadKeys) {
                if (!key.startsWith(`${environmentId}:`)) continue;
                const id = ThreadId.make(key.slice(key.indexOf(":") + 1));
                const shell = yield* orchestration
                  .getThreadShell(id)
                  .pipe(Effect.mapError(() => invalid("Could not read the ticket's sessions.")));
                if (
                  shell &&
                  (shell.activeRunId != null ||
                    (shell.pendingBackgroundTasks?.length ?? 0) > 0 ||
                    shell.status === "preparing" ||
                    shell.status === "queued" ||
                    shell.status === "starting" ||
                    shell.status === "running" ||
                    shell.status === "waiting")
                ) {
                  return yield* invalid(
                    "A linked session is already working on this ticket. Open that chat to follow its progress.",
                  );
                }
                if (shell && key === ticket.workflowThreadKey) resumeThreadId = id;
              }
              if (ticket.flag !== null) {
                yield* boards
                  .dispatch({ type: "ticket.resolveFlag", ticketId: ticket.id }, "user")
                  .pipe(Effect.mapError((error) => invalid(error.message)));
              }
              const preset = yield* store.get(ticket.workflow.presetId);
              const automation: StoredAutomation = {
                ...preset,
                trigger: { type: "workflow" },
                title: ticket.workflow.title,
                prompt: ticket.workflow.prompt,
                action: ticket.workflow.action,
              };
              const runId = yield* store.insertRun({
                automationId: preset.id,
                ticketId: ticket.id,
                status: "queued",
              });
              yield* startRun(automation, runId, ticket.id, resumeThreadId);
              const started = (yield* store.runsForTicket(ticket.id)).find(
                (run) => run.id === runId,
              );
              if (started?.status === "failed")
                return yield* invalid(started.reason ?? "The workflow could not start.");
              return { id: runId };
            }
            case "ticket.pauseWorkflow": {
              const snapshot = yield* boards.snapshot.pipe(
                Effect.mapError((error) => invalid(error.message)),
              );
              const ticket = snapshot.tickets.find(
                (candidate) => candidate.id === command.ticketId,
              );
              const key = ticket?.workflowThreadKey;
              if (!ticket || !key || !key.startsWith(`${environmentId}:`))
                return yield* invalid("This ticket has no workflow session.");
              const threadId = ThreadId.make(key.slice(key.indexOf(":") + 1));
              const shell = yield* orchestration
                .getThreadShell(threadId)
                .pipe(Effect.mapError(() => invalid("Could not read the workflow session.")));
              if (shell?.activeRunId) {
                yield* orchestration
                  .dispatch({
                    type: "run.interrupt",
                    commandId: CommandId.make(`server:workflow-pause:${yield* uuid}`),
                    threadId,
                    runId: shell.activeRunId,
                    reason: "The ticket workflow was paused.",
                    holdQueue: true,
                  })
                  .pipe(Effect.mapError(() => invalid("Could not pause the workflow session.")));
              }
              const running = yield* store.runningRunForThread(key);
              if (Option.isSome(running))
                yield* store.updateRun(running.value.id, {
                  status: "skipped",
                  reason: "Paused by the user.",
                  finishedAt: yield* nowIso,
                });
              yield* boards
                .dispatch(
                  {
                    type: "ticket.workflowSession",
                    ticketId: ticket.id,
                    threadKey: key,
                    event: "paused",
                  },
                  "user",
                )
                .pipe(Effect.mapError((error) => invalid(error.message)));
              yield* boards
                .dispatch(
                  {
                    type: "ticket.flag",
                    ticketId: ticket.id,
                    level: "warning",
                    reason: "Workflow paused. Resume when ready.",
                  },
                  "user",
                )
                .pipe(Effect.mapError((error) => invalid(error.message)));
              return { id: null };
            }
            case "automation.delete": {
              const current = yield* store.get(command.automationId);
              // Assigned tickets keep their instruction snapshot and run history.
              if (current.trigger.type === "workflow")
                yield* store.update(current.id, { enabled: false });
              else yield* store.remove(current.id);
              return { id: null };
            }
            case "automation.runNow": {
              const automation = yield* store.get(command.automationId);
              if (automation.trigger.type !== "schedule")
                return yield* invalid("Start or resume the workflow from its ticket.");
              const ticketId = command.ticketId ?? null;
              // One agent at a time per ticket: they share its workspace.
              if (ticketId !== null) {
                const runs = yield* store.runsForTicket(ticketId);
                if (runs.some((run) => run.status === "running")) {
                  return yield* invalid(
                    "An automation is already working on this ticket. Run it again when that chat ends.",
                  );
                }
              }
              const runId = yield* store.insertRun({
                automationId: automation.id,
                ticketId,
                status: "queued",
              });
              yield* startRun(automation, runId, ticketId);
              return { id: runId };
            }
            case "ticket.resumeHooks":
            case "board.pauseHooks":
              return yield* invalid(
                "Column hooks have been replaced by Start / Resume on the ticket workflow.",
              );
          }
        }),
      ).pipe(
        Effect.mapError((error) =>
          error._tag === "AutomationsCommandError" ? error : invalid(error.message),
        ),
      );

    return AutomationEngine.of({
      dispatch,
      handleDomainEvent,
      tick: scheduledTick,
    });
  });

export const layer = Layer.effect(AutomationEngine, make({ background: true }));

/** Without the background loops; tests drive the handlers themselves. */
export const layerManual = Layer.effect(AutomationEngine, make({ background: false }));
