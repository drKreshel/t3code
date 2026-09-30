import {
  type Automation,
  AutomationsCommandError,
  type AutomationSchedule,
  type AutomationsSnapshot,
  BoardColumnType,
  type BoardsSnapshot,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AutomationEngine } from "../automations/AutomationEngine.ts";
import { AutomationsStore } from "../automations/AutomationsStore.ts";
import { BoardsService } from "../boards/BoardsService.ts";
import { unavailableBoards } from "../rpcHandlers.ts";
import { type AutomationSummary, AutomationsToolkit } from "./automationsTools.ts";
import { findBoard, findColumn, findTicket, type Lookup } from "./boardsToolLogic.ts";

const isBoardColumnType = Schema.is(BoardColumnType);

const invalid = (message: string) => new AutomationsCommandError({ code: "invalid", message });
const notFound = (message: string) => new AutomationsCommandError({ code: "not-found", message });
const unavailable = new AutomationsCommandError({
  code: "storage",
  message: "Automations are not available on this server.",
});

const unwrap = <A>(lookup: Lookup<A>): Effect.Effect<A, AutomationsCommandError> =>
  lookup.ok ? Effect.succeed(lookup.value) : Effect.fail(notFound(lookup.message));

/** The zone the server runs in; T3 Code's server is usually the user's own machine. */
const serverTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

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
  if (trigger.boardId === null) {
    return `ticket enters a ${trigger.columnType ?? "?"} column on any board`;
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
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

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
    const thread = yield* snapshots
      .getThreadShellById(scope.threadId)
      .pipe(Effect.mapError(() => unavailable));
    if (Option.isNone(thread)) return yield* notFound("This chat was not found.");
    return `${scope.environmentId}:${thread.value.projectId}`;
  });

  const projectTitle = (projectKey: string | null) => {
    if (projectKey === null) return Effect.succeed(null);
    return snapshots
      .getProjectShellById(ProjectId.make(projectKey.slice(projectKey.indexOf(":") + 1)))
      .pipe(
        Effect.map((project) => (Option.isSome(project) ? project.value.title : projectKey)),
        Effect.orElseSucceed(() => projectKey),
      );
  };

  return AutomationsToolkit.of({
    list_automations: () =>
      Effect.gen(function* () {
        const snapshot = yield* automationsSnapshot;
        const boardState = yield* boardsSnapshot.pipe(Effect.orElseSucceed(() => null));
        const automations = yield* Effect.forEach(snapshot.automations, (automation) =>
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
        const hasBoard = input.board !== undefined || input.column !== undefined;
        if ((schedule === undefined) === !hasBoard) {
          return yield* invalid("Give either a schedule (cron or at) or a board and column.");
        }
        let trigger;
        if (schedule !== undefined) {
          trigger = {
            type: "schedule" as const,
            schedule,
            timezone: input.timezone ?? serverTimezone(),
          };
        } else {
          if (input.board === undefined || input.column === undefined) {
            return yield* invalid("A board hook needs both board and column.");
          }
          if (input.board === "*") {
            const columnType = input.column.toLowerCase();
            if (!isBoardColumnType(columnType)) {
              return yield* invalid(
                "For every board, column must be a column type: backlog, todo, active, review, attention, done, or canceled.",
              );
            }
            trigger = { type: "board" as const, boardId: null, columnId: null, columnType };
          } else {
            const state = yield* boardsSnapshot;
            const board = yield* unwrap(findBoard(state, input.board));
            const column = yield* unwrap(findColumn(board, input.column));
            trigger = { type: "board" as const, boardId: board.id, columnId: column.id };
          }
        }
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
          ...(input.maxRunsPerTicket !== undefined && input.maxRunsPerTicket > 0
            ? { maxRunsPerTicket: input.maxRunsPerTicket }
            : {}),
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
