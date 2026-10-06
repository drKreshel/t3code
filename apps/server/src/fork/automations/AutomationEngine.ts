/**
 * Runs scheduled automations: each firing starts a chat or applies built-in
 * steps, and its run settles when the chat's turn ends. Also links delegated
 * child chats to their parent's ticket.
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
  scheduleProblem,
  stepsProblem,
} from "./automationLogic.ts";
import { AutomationsStore, type StoredAutomation } from "./AutomationsStore.ts";

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

    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
    const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect);
    const actorOf = (automation: { readonly id: string }) => `automation:${automation.id}`;

    const boardsSnapshot = boards.snapshot.pipe(
      Effect.mapError((error) => new RunStartError({ message: error.message })),
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

    const startRun = (automation: StoredAutomation, runId: string) =>
      Effect.gen(function* () {
        if (automation.action.steps && automation.action.steps.length > 0) {
          const snapshot = yield* boardsSnapshot;
          const startedAt = yield* nowIso;
          yield* store.updateRun(runId, { status: "running", startedAt });
          yield* runSteps(automation, snapshot);
          yield* store.updateRun(runId, { status: "succeeded", finishedAt: yield* nowIso });
          return;
        }
        const projectKey = automation.action.projectKey;
        if (projectKey === null) {
          return yield* new RunStartError({
            message: "No project to start the chat in: set one on the automation.",
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
        if (automation.action.checkout === "worktree") {
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

        const threadId = ThreadId.make(yield* uuid);
        const createdAt = yield* nowIso;
        const dispatchFailed = (error: unknown) =>
          new RunStartError({
            message: `Could not start the chat: ${error instanceof Error ? error.message : String(error)}`,
          });
        yield* orchestration
          .dispatch({
            type: "thread.create",
            commandId: CommandId.make(`server:automation-thread:${yield* uuid}`),
            threadId,
            projectId,
            title: automation.title,
            modelSelection,
            runtimeMode: automation.action.runtimeMode,
            interactionMode: automation.action.interactionMode,
            branch,
            worktreePath,
            createdBy: "system",
            creationSource: "server",
          })
          .pipe(Effect.mapError(dispatchFailed));
        // Recorded before the turn starts, so a turn that ends at once is still matched.
        yield* store.updateRun(runId, {
          status: "running",
          threadKey: `${environmentId}:${threadId}`,
          startedAt: createdAt,
        });
        yield* orchestration
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`server:automation-turn:${yield* uuid}`),
            threadId,
            messageId: MessageId.make(yield* uuid),
            text: automation.prompt,
            attachments: [],
            createdBy: "system",
            creationSource: "server",
            dispatchMode: { type: "start_immediately" },
          })
          .pipe(Effect.mapError(dispatchFailed));
      }).pipe(
        Effect.catchTag("RunStartError", (error) => failRun(runId, error.message)),
        Effect.catch((error) =>
          failRun(runId, error instanceof Error ? error.message : "The run could not start."),
        ),
      );

    const failRun = (runId: string, reason: string) =>
      Effect.gen(function* () {
        yield* store.updateRun(runId, { status: "failed", reason, finishedAt: yield* nowIso });
      }).pipe(
        Effect.catch((error) => Effect.logWarning("Could not record a failed run", { error })),
      );

    /** A deleted chat fails its run and leaves its ticket. */
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
        yield* store.updateRun(run.value.id, {
          status: outcome.status,
          reason: outcome.reason,
          finishedAt: yield* nowIso,
        });
      });

    /** Carry existing ticket blockers into the chat that raised them. */
    const migrateTicketBlockers = Effect.gen(function* () {
      for (const ticket of (yield* boards.snapshot).tickets) {
        const flag = ticket.flag;
        if (flag?.level !== "warning" || ticket.archivedAt !== null) continue;
        if (flag.reason === "Workflow paused. Resume when ready.") {
          yield* boards.dispatch({ type: "ticket.resolveFlag", ticketId: ticket.id }, "system");
          continue;
        }
        const key = flag.by.startsWith("thread:") ? flag.by.slice(7) : null;
        if (!key?.startsWith(`${environmentId}:`)) continue;
        const threadId = ThreadId.make(key.slice(key.indexOf(":") + 1));
        const shell = yield* orchestration.getThreadShell(threadId);
        if (!shell || shell.archivedAt !== null) continue;
        yield* orchestration.dispatch({
          type: "thread.request-human",
          commandId: CommandId.make(`legacy-ticket-blocker:${ticket.id}:${flag.at}`),
          threadId,
          reason: flag.reason,
        });
        yield* boards.dispatch({ type: "ticket.resolveFlag", ticketId: ticket.id }, "system");
      }
    });

    /** One scheduler pass: fire due schedules, record missed ones. */
    const tick = Effect.gen(function* () {
      yield* migrateTicketBlockers;
      const now = yield* DateTime.now;
      for (const automation of yield* store.list) {
        if (!automation.enabled) continue;
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
            status: "missed",
            reason: `T3 Code was not running at ${due ? DateTime.formatIso(due) : "the scheduled time"}.`,
          });
          continue;
        }
        const runId = yield* store.insertRun({ automationId: automation.id, status: "queued" });
        yield* startRun(automation, runId);
      }
    });

    /** Runs left `running` while the server was off may have finished meanwhile. */
    const reconcile = Effect.gen(function* () {
      yield* migrateTicketBlockers;
      for (const run of yield* store.runsWithStatus("running")) {
        if (run.threadKey !== null) yield* settleThread(run.threadKey, null);
      }
    });

    const logged = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => Effect.logWarning(`Automation ${label} failed`, { cause })),
      );

    /** Files a chat another chat started or briefed under that chat's ticket. */
    const linkToParentTicket = (childThreadId: string, parentThreadId: string) => {
      const parentKey = `${environmentId}:${parentThreadId}`;
      const childKey = `${environmentId}:${childThreadId}`;
      return logged(
        "child chat linking",
        serialized(
          Effect.gen(function* () {
            const snapshot = yield* boards.snapshot;
            // A chat already on a ticket stays there.
            if (snapshot.tickets.some((candidate) => candidate.threadKeys.includes(childKey)))
              return;
            const ticket = snapshot.tickets.find((candidate) =>
              candidate.threadKeys.includes(parentKey),
            );
            if (!ticket) return;
            yield* boards.dispatch(
              { type: "thread.link", ticketId: ticket.id, threadKey: childKey },
              `thread:${parentKey}`,
            );
          }),
        ),
      );
    };

    const handleDomainEvent = (event: OrchestrationV2DomainEvent) => {
      // Subagents, delegated tasks, and forks.
      if (event.type === "thread.created" && event.payload.lineage.parentThreadId !== null) {
        return linkToParentTicket(event.threadId, event.payload.lineage.parentThreadId);
      }
      if (event.type === "turn-item.updated") {
        const item = event.payload;
        // Chats an agent started with create_threads.
        if (item.type === "thread_created")
          return linkToParentTicket(item.targetThreadId, event.threadId);
        // Chats an agent launched or messaged (t3_thread_launch, t3_thread_send).
        if (item.type === "user_message" && item.senderThreadId !== undefined)
          return linkToParentTicket(event.threadId, item.senderThreadId);
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
              const problem =
                scheduleProblem(command.trigger) ?? stepsProblem(command.action, command.prompt);
              if (problem) return yield* invalid(problem);
              if ((command.action.steps?.length ?? 0) === 0 && command.action.projectKey === null) {
                return yield* invalid("A scheduled automation needs a project.");
              }
              const id = yield* store.create({
                title: command.title,
                prompt: command.prompt,
                trigger: command.trigger,
                action: command.action,
                enabled: command.enabled ?? true,
              });
              return { id };
            }
            case "automation.update": {
              const current = yield* store.get(command.automationId);
              const problem =
                (command.trigger ? scheduleProblem(command.trigger) : null) ??
                stepsProblem(command.action ?? current.action, command.prompt ?? current.prompt);
              if (problem) return yield* invalid(problem);
              yield* store.update(command.automationId, {
                ...(command.title !== undefined ? { title: command.title } : {}),
                ...(command.prompt !== undefined ? { prompt: command.prompt } : {}),
                ...(command.trigger !== undefined ? { trigger: command.trigger } : {}),
                ...(command.action !== undefined ? { action: command.action } : {}),
                ...(command.enabled !== undefined ? { enabled: command.enabled } : {}),
              });
              return { id: null };
            }
            case "automation.delete": {
              yield* store.get(command.automationId);
              yield* store.remove(command.automationId);
              return { id: null };
            }
            case "automation.runNow": {
              const automation = yield* store.get(command.automationId);
              const runId = yield* store.insertRun({
                automationId: automation.id,
                status: "queued",
              });
              yield* startRun(automation, runId);
              return { id: runId };
            }
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
