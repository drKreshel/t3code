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
 * - blocked tickets never trigger; they fire when unblocked;
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
  type OrchestrationEvent,
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
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../../serverActivation.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { type BoardEvent, BoardsService } from "../boards/BoardsService.ts";
import {
  boardTriggerMatches,
  boardTriggerProblem,
  decideSchedule,
  isBlocked,
  nextScheduledAt,
  renderPrompt,
  scheduleProblem,
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
    readonly handleBoardEvent: (event: BoardEvent) => Effect.Effect<void>;
    readonly handleDomainEvent: (event: OrchestrationEvent) => Effect.Effect<void>;
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
    const orchestration = yield* OrchestrationEngine.OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
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

    const ticketLabel = (snapshot: BoardsSnapshot, ticket: Ticket) => {
      const board = snapshot.boards.find((candidate) => candidate.id === ticket.boardId);
      return `${board?.key ?? "?"}-${ticket.number}`;
    };

    /** Moves a ticket to its board's attention column with a reason; quiet if it has none. */
    const escalate = (ticketId: string, reason: string, actor: string) =>
      Effect.gen(function* () {
        const snapshot = yield* boards.snapshot;
        const ticket = snapshot.tickets.find((candidate) => candidate.id === ticketId);
        const board = snapshot.boards.find((candidate) => candidate.id === ticket?.boardId);
        const attention = board?.columns
          .toSorted((a, b) => a.position - b.position)
          .find((column) => column.type === "attention");
        if (!ticket || !attention) return;
        yield* boards.dispatch(
          { type: "ticket.move", ticketId, columnId: attention.id, reason },
          actor,
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Automation could not escalate ticket", { error }),
        ),
      );

    const defaultModel = (projectId: ProjectId) =>
      Effect.gen(function* () {
        const settings = yield* settingsService.getSettings;
        const project = yield* snapshots.getProjectShellById(projectId).pipe(
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
    const startRun = (automation: StoredAutomation, runId: string, ticketId: string | null) =>
      Effect.gen(function* () {
        const snapshot = yield* boardsSnapshot;
        const ticket =
          ticketId === null ? undefined : snapshot.tickets.find((t) => t.id === ticketId);
        if (ticketId !== null && !ticket)
          return yield* new RunStartError({ message: "The ticket no longer exists." });
        const board = ticket ? snapshot.boards.find((b) => b.id === ticket.boardId) : undefined;

        const projectKey =
          automation.action.projectKey ?? ticket?.projectKey ?? board?.defaultProjectKey ?? null;
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
        const project = yield* snapshots.getProjectShellById(projectId).pipe(
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
            createdAt,
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
        yield* orchestration
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`server:automation-turn:${yield* uuid}`),
            threadId,
            message: {
              messageId: MessageId.make(yield* uuid),
              role: "user",
              text,
              attachments: [],
            },
            runtimeMode: automation.action.runtimeMode,
            interactionMode: automation.action.interactionMode,
            createdAt: yield* nowIso,
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
          yield* escalate(ticketId, `"${automation.title}" failed: ${reason}`, actorOf(automation));
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
        if (isBlocked(snapshot, ticket)) return;

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
          yield* escalate(ticketId, reason, actorOf(automation));
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
          boardTriggerMatches(automation.value.trigger, snapshot, ticket) &&
          !isBlocked(snapshot, ticket);
        if (!stillApplies || Option.isNone(automation)) {
          yield* store.updateRun(queued.id, {
            status: "skipped",
            reason: "The ticket left the column before its turn came.",
            finishedAt: yield* nowIso,
          });
          return;
        }
        // Through fireHook, so a queued run still respects the run limit.
        yield* fireHook(automation.value, ticketId, queued.id);
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
          const shell = yield* snapshots.getThreadShellById(threadId).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.orElseSucceed(() => undefined),
          );
          const state = shell?.latestTurn?.state;
          if (state === undefined || state === "running") return;
          outcome =
            state === "completed"
              ? { status: "succeeded", reason: null }
              : state === "interrupted"
                ? { status: "failed", reason: "The chat was stopped." }
                : {
                    status: "failed",
                    reason: shell?.session?.lastError ?? "The chat's turn failed.",
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
            if (event.type === "ticket.unblocked") {
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

    const handleDomainEvent = (event: OrchestrationEvent) => {
      if (event.type === "thread.session-set") {
        const status = event.payload.session.status;
        if (status === "running" || status === "starting") return Effect.void;
        return logged(
          "turn end",
          serialized(settleThread(`${environmentId}:${event.payload.threadId}`, null)),
        );
      }
      if (
        event.type === "thread.activity-appended" &&
        event.payload.activity.kind === "provider.turn.start.failed"
      ) {
        return logged(
          "turn start failure",
          serialized(
            settleThread(
              `${environmentId}:${event.payload.threadId}`,
              "The agent could not start the turn.",
            ),
          ),
        );
      }
      return Effect.void;
    };

    const scheduledTick = logged("scheduler", serialized(tick));

    if (options.background) {
      const boardEvents = Stream.fromSubscription(yield* boards.subscribeEvents);
      const domainEvents = yield* orchestration.subscribeDomainEvents;
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
              if (command.trigger.type === "schedule" && command.action.projectKey === null) {
                return yield* invalid("A scheduled automation needs a project.");
              }
              const id = yield* store.create({
                title: command.title,
                prompt: command.prompt,
                trigger: command.trigger,
                action: command.action,
                enabled: command.enabled ?? true,
                maxRunsPerTicket: command.maxRunsPerTicket ?? 3,
              });
              return { id };
            }
            case "automation.update": {
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
              const runId = yield* store.insertRun({
                automationId: automation.id,
                ticketId,
                status: "queued",
              });
              yield* startRun(automation, runId, ticketId);
              return { id: runId };
            }
            case "ticket.resumeHooks":
              yield* store.resetTicket(command.ticketId, yield* nowIso);
              yield* fireHooksForTicket(command.ticketId).pipe(
                Effect.catch((error) => Effect.logWarning("Resume hooks failed", { error })),
              );
              return { id: null };
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
