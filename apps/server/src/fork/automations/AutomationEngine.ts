/**
 * Runs automations: fires schedules, reacts to tickets entering hooked
 * columns, starts the chats, and follows each chat to the end of its turn.
 *
 * Safeguards (nothing is dropped silently):
 * - a hook runs at most `maxRunsPerTicket` times per ticket since its counter
 *   was reset (by Resume hooks or a person moving the ticket); then the ticket
 *   goes to Needs you with the reason;
 * - one live automation chat per ticket; a trigger meanwhile is queued (one
 *   per ticket) and starts when the live chat finishes;
 * - a paused board's hooks do not fire; unpausing runs them for tickets
 *   sitting in hooked columns;
 * - a schedule missed while the server was off runs once if within an hour,
 *   otherwise it is recorded as missed.
 *
 * All handling goes through one lock, so two events for the same ticket
 * cannot both decide it has no live run.
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
import { type BoardEvent, BoardsService } from "../boards/BoardsService.ts";
import {
  boardTriggerMatches,
  boardTriggerProblem,
  decideSchedule,
  nextScheduledAt,
  renderPrompt,
  scheduleProblem,
  stepsProblem,
} from "./automationLogic.ts";
import { AutomationsStore, type StoredAutomation } from "./AutomationsStore.ts";
import { TicketWorkspaces } from "../workspaces/TicketWorkspaces.ts";

const SCHEDULER_TICK = "20 seconds";

export class AutomationEngine extends Context.Service<
  AutomationEngine,
  {
    readonly dispatch: (
      command: AutomationsCommand,
    ) => Effect.Effect<AutomationsCommandResult, AutomationsCommandError>;
    /** What the background loops call per event; tests call them directly. */
    readonly handleBoardEvent: (event: BoardEvent) => Effect.Effect<void>;
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

    /**
     * Flags a ticket for a person: red for a failed run, yellow for a stop
     * (run limit). Its hooks then wait until the flag is resolved.
     */
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

    /**
     * Starts the chat for a run that already has a row, and marks it running.
     * The chat is linked to the ticket for board runs.
     */
    /** Applies built-in steps in order; the first failure stops the rest. */
    const runSteps = (
      automation: StoredAutomation,
      ticket: Ticket | undefined,
      snapshot: BoardsSnapshot,
    ) =>
      Effect.gen(function* () {
        const actor = actorOf(automation);
        const asStepError = (error: { readonly message: string }) =>
          new RunStartError({ message: error.message });
        for (const step of automation.action.steps ?? []) {
          if (step.type === "moveStale") {
            const cutoff =
              DateTime.toEpochMillis(yield* DateTime.now) -
              step.olderThanDays * 24 * 60 * 60 * 1000;
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
            continue;
          }
          if (!ticket) {
            return yield* new RunStartError({ message: "This step needs a ticket to act on." });
          }
          switch (step.type) {
            case "moveTo": {
              const board = snapshot.boards.find((candidate) => candidate.id === ticket.boardId);
              const column = board?.columns.find(
                (candidate) =>
                  candidate.name.trim().toLowerCase() === step.column.trim().toLowerCase(),
              );
              if (!column) {
                return yield* new RunStartError({
                  message: `The board has no column named "${step.column}".`,
                });
              }
              yield* boards
                .dispatch({ type: "ticket.move", ticketId: ticket.id, columnId: column.id }, actor)
                .pipe(Effect.mapError(asStepError));
              break;
            }
            case "removeWorkspace":
              if (Option.isNone(workspaces)) break;
              yield* workspaces.value
                .dispatch({ type: "workspace.remove", ticketId: ticket.id })
                .pipe(Effect.mapError(asStepError));
              break;
          }
        }
      });

    const startRun = (automation: StoredAutomation, runId: string, ticketId: string | null) =>
      Effect.gen(function* () {
        const snapshot = yield* boardsSnapshot;
        const ticket =
          ticketId === null ? undefined : snapshot.tickets.find((t) => t.id === ticketId);
        if (ticketId !== null && !ticket)
          return yield* new RunStartError({ message: "The ticket no longer exists." });
        if (automation.action.steps && automation.action.steps.length > 0) {
          const startedAt = yield* nowIso;
          yield* store.updateRun(runId, { status: "running", startedAt });
          yield* runSteps(automation, ticket, snapshot);
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
        if (automation.action.checkout === "ticket") {
          if (!ticket) {
            return yield* new RunStartError({
              message: "Only board hooks can use the ticket's workspace.",
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
        } else if (automation.action.checkout === "worktree") {
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
        const text = renderPrompt(automation.prompt, {
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

        const threadId = ThreadId.make(yield* uuid);
        const createdAt = yield* nowIso;
        const title = ticket
          ? `${ticketLabel(snapshot, ticket)} · ${automation.title}`
          : automation.title;
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
            .dispatch({ type: "thread.link", threadKey, ticketId: ticket.id }, actorOf(automation))
            .pipe(Effect.catch(() => Effect.void));
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
      automation: { readonly id: string; readonly title: string },
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
        }
      }).pipe(
        Effect.catch((error) => Effect.logWarning("Could not record a failed run", { error })),
      );

    const hookRunsSinceReset = (automationId: string, ticketId: string) =>
      Effect.gen(function* () {
        const resetAt = yield* store.ticketResetAt(ticketId);
        const runs = yield* store.runsForTicket(ticketId);
        return runs.filter(
          (run) =>
            run.automationId === automationId &&
            run.startedAt !== null &&
            (resetAt === null || run.createdAt > resetAt),
        ).length;
      });

    /** A ticket is in (or just entered) a hooked column: run, queue, or stop. */
    const fireHook = (automation: StoredAutomation, ticketId: string, queuedRunId?: string) =>
      Effect.gen(function* () {
        if (!automation.enabled || automation.trigger.type !== "board") return;
        const snapshot = yield* boards.snapshot;
        const ticket = snapshot.tickets.find((candidate) => candidate.id === ticketId);
        if (!ticket || ticket.archivedAt !== null) return;
        if (!boardTriggerMatches(automation.trigger, snapshot, ticket)) return;
        // The ticket's own board decides pausing, including for any-board hooks.
        if (yield* store.boardPaused(ticket.boardId)) return;
        // A flagged ticket waits for a person; resolving the flag runs this again.
        if (ticket.flag !== null) return;

        const runs = yield* store.runsForTicket(ticketId);
        if (queuedRunId === undefined && runs.some((run) => run.status === "running")) {
          if (!runs.some((run) => run.status === "queued")) {
            yield* store.insertRun({ automationId: automation.id, ticketId, status: "queued" });
          }
          return;
        }
        if ((yield* hookRunsSinceReset(automation.id, ticketId)) >= automation.maxRunsPerTicket) {
          const reason = `"${automation.title}" ran ${automation.maxRunsPerTicket} times on this ticket without it moving on. Resume hooks to try again.`;
          if (queuedRunId === undefined) {
            yield* store.insertRun({
              automationId: automation.id,
              ticketId,
              status: "skipped",
              reason,
            });
          } else {
            yield* store.updateRun(queuedRunId, {
              status: "skipped",
              reason,
              finishedAt: yield* nowIso,
            });
          }
          yield* escalate(ticketId, reason, actorOf(automation), "warning");
          return;
        }
        const runId =
          queuedRunId ??
          (yield* store.insertRun({ automationId: automation.id, ticketId, status: "queued" }));
        yield* startRun(automation, runId, ticketId);
      });

    /** Runs every hook that watches the ticket's current column. */
    const fireHooksForTicket = (ticketId: string) =>
      Effect.gen(function* () {
        const snapshot = yield* boards.snapshot;
        const ticket = snapshot.tickets.find((candidate) => candidate.id === ticketId);
        if (!ticket) return;
        const hooks = (yield* store.list).filter(
          (automation) =>
            automation.enabled && boardTriggerMatches(automation.trigger, snapshot, ticket),
        );
        for (const automation of hooks) {
          yield* fireHook(automation, ticketId);
        }
      });

    /** After a ticket's live run ends: start its queued run if it still applies. */
    const startQueued = (ticketId: string) =>
      Effect.gen(function* () {
        const queued = (yield* store.runsForTicket(ticketId)).find(
          (run) => run.status === "queued",
        );
        if (!queued) return;
        const automation = yield* store.get(queued.automationId).pipe(Effect.option);
        const snapshot = yield* boards.snapshot;
        const ticket = snapshot.tickets.find((candidate) => candidate.id === ticketId);
        const stillApplies =
          Option.isSome(automation) &&
          automation.value.enabled &&
          ticket !== undefined &&
          boardTriggerMatches(automation.value.trigger, snapshot, ticket);
        if (!stillApplies || Option.isNone(automation)) {
          yield* store.updateRun(queued.id, {
            status: "skipped",
            reason: "The ticket left the column before its turn came.",
            finishedAt: yield* nowIso,
          });
          // Only one run waits per ticket, so the column it moved on to has not run yet.
          yield* fireHooksForTicket(ticketId);
          return;
        }
        // Through fireHook, so a queued run still respects the run limit.
        yield* fireHook(automation.value, ticketId, queued.id);
      });

    /** The run's chat was deleted: a person stopped it, so no flag; the next run may start. */
    const settleDeleted = (threadKey: string) =>
      Effect.gen(function* () {
        const run = yield* store.runningRunForThread(threadKey);
        if (Option.isNone(run)) return;
        yield* store.updateRun(run.value.id, {
          status: "failed",
          reason: "The chat was deleted.",
          finishedAt: yield* nowIso,
        });
        if (run.value.ticketId !== null) yield* startQueued(run.value.ticketId);
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
        }
        if (run.value.ticketId !== null) yield* startQueued(run.value.ticketId);
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

    const handleBoardEvent = (event: BoardEvent) =>
      logged(
        "board event",
        serialized(
          Effect.gen(function* () {
            if (event.type === "ticket.flagResolved") {
              // Resolving gives the hooks a fresh count, then runs what was held.
              yield* store.resetTicket(event.ticketId, yield* nowIso);
              yield* fireHooksForTicket(event.ticketId);
              return;
            }
            // A person moving a ticket gives its hooks a fresh start.
            if (event.actor === "user") yield* store.resetTicket(event.ticketId, yield* nowIso);
            // The ticket now sits in the column it entered; run what watches it.
            yield* fireHooksForTicket(event.ticketId);
          }),
        ),
      );

    const handleDomainEvent = (event: OrchestrationV2DomainEvent) => {
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
      const boardEvents = Stream.fromSubscription(yield* boards.subscribeEvents);
      const domainEvents = orchestration.streamDomainEvents;
      yield* forkParked(
        Effect.gen(function* () {
          yield* logged("reconcile", serialized(reconcile));
          yield* Effect.forkScoped(
            scheduledTick.pipe(Effect.repeat(Schedule.spaced(SCHEDULER_TICK))),
          );
          yield* Effect.forkScoped(Stream.runForEach(boardEvents, handleBoardEvent));
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
                scheduleProblem(command.trigger) ?? boardTriggerProblem(command.trigger);
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
                // A safety net against runaway loops; hook prompts decide sooner.
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
                const problem =
                  scheduleProblem(command.trigger) ?? boardTriggerProblem(command.trigger);
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
            case "automation.delete":
              yield* store.remove(command.automationId);
              return { id: null };
            case "automation.runNow": {
              const automation = yield* store.get(command.automationId);
              if (automation.trigger.type === "board" && command.ticketId === undefined) {
                return yield* invalid("Pick the ticket to run this hook for.");
              }
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
            case "ticket.resumeHooks": {
              // Same as resolving the flag: fresh count, then the held hooks run.
              const snapshot = yield* boards.snapshot.pipe(
                Effect.mapError((error) => invalid(error.message)),
              );
              const flagged =
                snapshot.tickets.find((ticket) => ticket.id === command.ticketId)?.flag != null;
              if (flagged) {
                // The flag-resolved event resets the count and runs the hooks.
                yield* boards
                  .dispatch({ type: "ticket.resolveFlag", ticketId: command.ticketId }, "user")
                  .pipe(Effect.mapError((error) => invalid(error.message)));
              } else {
                yield* store.resetTicket(command.ticketId, yield* nowIso);
                yield* fireHooksForTicket(command.ticketId).pipe(
                  Effect.catch((error) => Effect.logWarning("Resume hooks failed", { error })),
                );
              }
              return { id: null };
            }
            case "board.pauseHooks": {
              yield* store.setBoardPaused(command.boardId, command.paused);
              if (!command.paused) {
                const snapshot = yield* boards.snapshot.pipe(
                  Effect.mapError((error) => invalid(error.message)),
                );
                for (const ticket of snapshot.tickets) {
                  if (ticket.boardId !== command.boardId || ticket.archivedAt !== null) continue;
                  yield* fireHooksForTicket(ticket.id).pipe(Effect.catch(() => Effect.void));
                }
              }
              return { id: null };
            }
          }
        }),
      );

    return AutomationEngine.of({
      dispatch,
      handleBoardEvent,
      handleDomainEvent,
      tick: scheduledTick,
    });
  });

export const layer = Layer.effect(AutomationEngine, make({ background: true }));

/** Without the background loops; tests drive the handlers themselves. */
export const layerManual = Layer.effect(AutomationEngine, make({ background: false }));
