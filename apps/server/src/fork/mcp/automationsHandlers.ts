import {
  type Automation,
  AutomationsCommandError,
  type AutomationSchedule,
  type AutomationsSnapshot,
  type BoardsSnapshot,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { AutomationEngine } from "../automations/AutomationEngine.ts";
import { anyBoardColumnName, serverTimezone } from "../automations/automationLogic.ts";
import { AutomationsStore } from "../automations/AutomationsStore.ts";
import { BoardsService } from "../boards/BoardsService.ts";
import { unavailableBoards } from "../rpcHandlers.ts";
import { type AutomationSummary, AutomationsToolkit } from "./automationsTools.ts";
import { findTicket, type Lookup } from "./boardsToolLogic.ts";

const invalid = (message: string) => new AutomationsCommandError({ code: "invalid", message });
const notFound = (message: string) => new AutomationsCommandError({ code: "not-found", message });
const unavailable = new AutomationsCommandError({
  code: "storage",
  message: "Automations are not available on this server.",
});

const unwrap = <A>(lookup: Lookup<A>): Effect.Effect<A, AutomationsCommandError> =>
  lookup.ok ? Effect.succeed(lookup.value) : Effect.fail(notFound(lookup.message));

/** A schedule from the tool's cron/at inputs, or undefined when neither was given. */
function scheduleOf(input: {
  readonly cron?: string | undefined;
  readonly at?: string | undefined;
}): Effect.Effect<AutomationSchedule | undefined, AutomationsCommandError> {
  if (input.cron !== undefined && input.at !== undefined) {
    return Effect.fail(invalid("Pass cron or at, not both."));
  }
  if (input.cron !== undefined) return Effect.succeed({ kind: "cron", cron: input.cron });
  if (input.at !== undefined) {
    const at = DateTime.make(input.at);
    return Option.isNone(at)
      ? Effect.fail(invalid(`"${input.at}" is not a date-time.`))
      : Effect.succeed({ kind: "once", at: DateTime.formatIso(at.value) });
  }
  return Effect.succeed(undefined);
}

function describeTrigger(automation: Automation, boards: BoardsSnapshot | null): string {
  const { trigger } = automation;
  if (trigger.type === "schedule") {
    return trigger.schedule.kind === "cron"
      ? `cron ${trigger.schedule.cron} (${trigger.timezone})`
      : `once at ${trigger.schedule.at}`;
  }
  if (trigger.type === "workflow") return "ticket workflow preset (explicit Start / Resume)";
  if (trigger.boardId === null) {
    return `ticket enters a column named "${anyBoardColumnName(trigger) ?? "?"}" on any board`;
  }
  const board = boards?.boards.find((candidate) => candidate.id === trigger.boardId);
  const column = board?.columns.find((candidate) => candidate.id === trigger.columnId);
  return `ticket enters ${board?.key ?? "a deleted board"} › ${column?.name ?? "a deleted column"}`;
}

function findAutomation(
  snapshot: AutomationsSnapshot,
  ref: string,
): Effect.Effect<Automation, AutomationsCommandError> {
  const wanted = ref.trim().toLowerCase();
  const automation =
    snapshot.automations.find((candidate) => candidate.id === ref.trim()) ??
    snapshot.automations.find((candidate) => candidate.title.toLowerCase() === wanted);
  if (automation) return Effect.succeed(automation);
  const titles = snapshot.automations.map((candidate) => candidate.title);
  return Effect.fail(
    notFound(
      titles.length === 0
        ? "There are no automations yet."
        : `No automation "${ref}". Automations: ${titles.join(", ")}.`,
    ),
  );
}

const make = Effect.gen(function* () {
  const engine = yield* Effect.serviceOption(AutomationEngine);
  const store = yield* Effect.serviceOption(AutomationsStore);
  const boards = Option.getOrElse(
    yield* Effect.serviceOption(BoardsService),
    () => unavailableBoards,
  );
  const threads = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;

  const requireEngine = Option.match(engine, {
    onNone: () => Effect.fail(unavailable),
    onSome: Effect.succeed,
  });
  const automationsSnapshot = Option.match(store, {
    onNone: () => Effect.fail(unavailable),
    onSome: (value) => value.snapshot,
  });
  const boardsSnapshot = boards.snapshot.pipe(
    Effect.mapError(
      (error) => new AutomationsCommandError({ code: "storage", message: error.message }),
    ),
  );

  const callerProjectKey = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const thread = yield* threads
      .getThreadShell(scope.threadId)
      .pipe(Effect.mapError(() => unavailable));
    if (thread === null) return yield* notFound("This chat was not found.");
    return `${scope.environmentId}:${thread.projectId}`;
  });

  const projectTitle = (projectKey: string | null) => {
    if (projectKey === null) return Effect.succeed(null);
    return projects.getShell(ProjectId.make(projectKey.slice(projectKey.indexOf(":") + 1))).pipe(
      Effect.map((project) => (Option.isSome(project) ? project.value.title : projectKey)),
      Effect.orElseSucceed(() => projectKey),
    );
  };

  return AutomationsToolkit.of({
    list_workflows: () =>
      Effect.gen(function* () {
        const snapshot = yield* automationsSnapshot;
        return {
          workflows: snapshot.automations
            .filter((preset) => preset.trigger.type === "workflow" && preset.enabled)
            .map((preset) => ({
              id: preset.id,
              title: preset.title,
              instructions: preset.prompt,
              action: preset.action,
            })),
        };
      }),
    create_workflow: (input) =>
      Effect.gen(function* () {
        const result = yield* (yield* requireEngine).dispatch({
          type: "automation.create",
          title: input.title,
          prompt: input.instructions,
          trigger: { type: "workflow" },
          action: {
            projectKey: null,
            modelSelection: input.modelSelection ?? null,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            checkout: input.checkout ?? "ticket",
          },
        });
        return { id: result.id ?? "", title: input.title };
      }),
    update_workflow: (input) =>
      Effect.gen(function* () {
        const preset = yield* findAutomation(yield* automationsSnapshot, input.workflow);
        if (preset.trigger.type !== "workflow") return yield* invalid("Choose a workflow preset.");
        yield* (yield* requireEngine).dispatch({
          type: "automation.update",
          automationId: preset.id,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.instructions !== undefined ? { prompt: input.instructions } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          action: {
            ...preset.action,
            ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
            ...(input.checkout !== undefined ? { checkout: input.checkout } : {}),
          },
        });
        return { id: preset.id, title: input.title ?? preset.title };
      }),
    start_workflow: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const snapshot = yield* boardsSnapshot;
        const ticket =
          input.ticket !== undefined
            ? yield* unwrap(findTicket(snapshot, input.ticket))
            : snapshot.tickets.find((candidate) =>
                candidate.threadKeys.includes(`${scope.environmentId}:${scope.threadId}`),
              );
        if (!ticket) return yield* notFound("Pass a ticket key or link this chat to a ticket.");
        const result = yield* (yield* requireEngine).dispatch({
          type: "ticket.startWorkflow",
          ticketId: ticket.id,
        });
        const started = (yield* boardsSnapshot).tickets.find(
          (candidate) => candidate.id === ticket.id,
        );
        const board = snapshot.boards.find((candidate) => candidate.id === ticket.boardId);
        return {
          ticket: `${board?.key}-${ticket.number}`,
          threadKey: started?.workflowThreadKey ?? null,
          runId: result.id ?? "",
        };
      }),
    pause_workflow: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const snapshot = yield* boardsSnapshot;
        const ticket =
          input.ticket !== undefined
            ? yield* unwrap(findTicket(snapshot, input.ticket))
            : snapshot.tickets.find((candidate) =>
                candidate.threadKeys.includes(`${scope.environmentId}:${scope.threadId}`),
              );
        if (!ticket) return yield* notFound("Pass a ticket key or link this chat to a ticket.");
        yield* (yield* requireEngine).dispatch({
          type: "ticket.pauseWorkflow",
          ticketId: ticket.id,
        });
        return {
          ticket: `${snapshot.boards.find((candidate) => candidate.id === ticket.boardId)?.key}-${ticket.number}`,
        };
      }),
    list_automations: () =>
      Effect.gen(function* () {
        const snapshot = yield* automationsSnapshot;
        const boardState = yield* boardsSnapshot.pipe(Effect.orElseSucceed(() => null));
        const automations = yield* Effect.forEach(
          snapshot.automations.filter((automation) => automation.trigger.type === "schedule"),
          (automation) =>
            Effect.gen(function* () {
              // Runs are newest first.
              const last = snapshot.runs.find((run) => run.automationId === automation.id);
              return {
                id: automation.id,
                title: automation.title,
                enabled: automation.enabled,
                trigger: describeTrigger(automation, boardState),
                prompt: automation.prompt,
                project: yield* projectTitle(automation.action.projectKey),
                nextRunAt: automation.nextRunAt,
                lastRun: last
                  ? {
                      status: last.status,
                      reason: last.reason,
                      at: last.finishedAt ?? last.startedAt ?? last.createdAt,
                    }
                  : null,
              } satisfies AutomationSummary;
            }),
        );
        return { automations };
      }),

    create_automation: (input) =>
      Effect.gen(function* () {
        const schedule = yield* scheduleOf(input);
        if (schedule === undefined)
          return yield* invalid(
            "Give cron or at for a scheduled automation. Use create_workflow for ticket instructions.",
          );
        const trigger = {
          type: "schedule" as const,
          schedule,
          timezone: input.timezone ?? serverTimezone(),
        };
        const projectKey = input.useThisChatsProject === true ? yield* callerProjectKey : null;
        const result = yield* (yield* requireEngine).dispatch({
          type: "automation.create",
          title: input.title,
          prompt: input.prompt,
          trigger,
          action: {
            projectKey,
            modelSelection: null,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            checkout: input.checkout ?? "local",
          },
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        });
        return { id: result.id ?? "", title: input.title };
      }),

    update_automation: (input) =>
      Effect.gen(function* () {
        const automation = yield* findAutomation(yield* automationsSnapshot, input.automation);
        const schedule = yield* scheduleOf(input);
        const retime = schedule !== undefined || input.timezone !== undefined;
        if (retime && automation.trigger.type !== "schedule") {
          return yield* invalid("Only scheduled automations have a schedule.");
        }
        const trigger =
          retime && automation.trigger.type === "schedule"
            ? {
                ...automation.trigger,
                ...(schedule !== undefined ? { schedule } : {}),
                ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
              }
            : undefined;
        yield* (yield* requireEngine).dispatch({
          type: "automation.update",
          automationId: automation.id,
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
          ...(trigger !== undefined ? { trigger } : {}),
        });
        return { id: automation.id, title: input.title ?? automation.title };
      }),

    delete_automation: ({ automation: ref }) =>
      Effect.gen(function* () {
        const automation = yield* findAutomation(yield* automationsSnapshot, ref);
        yield* (yield* requireEngine).dispatch({
          type: "automation.delete",
          automationId: automation.id,
        });
        return { id: automation.id, title: automation.title };
      }),

    run_automation: (input) =>
      Effect.gen(function* () {
        const automation = yield* findAutomation(yield* automationsSnapshot, input.automation);
        const ticketId =
          input.ticket === undefined
            ? undefined
            : (yield* unwrap(findTicket(yield* boardsSnapshot, input.ticket))).id;
        yield* (yield* requireEngine).dispatch({
          type: "automation.runNow",
          automationId: automation.id,
          ...(ticketId !== undefined ? { ticketId } : {}),
        });
        return { id: automation.id, title: automation.title };
      }),
  });
});

export const AutomationsToolkitHandlersLive = AutomationsToolkit.toLayer(make);
