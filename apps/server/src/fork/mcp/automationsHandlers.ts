import {
  type Automation,
  AutomationsCommandError,
  type AutomationSchedule,
  type AutomationsSnapshot,
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
import { serverTimezone } from "../automations/automationLogic.ts";
import { AutomationsStore } from "../automations/AutomationsStore.ts";
import { type AutomationSummary, AutomationsToolkit } from "./automationsTools.ts";

const invalid = (message: string) => new AutomationsCommandError({ code: "invalid", message });
const notFound = (message: string) => new AutomationsCommandError({ code: "not-found", message });
const unavailable = new AutomationsCommandError({
  code: "storage",
  message: "Automations are not available on this server.",
});

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

function describeTrigger({ trigger }: Automation): string {
  return trigger.schedule.kind === "cron"
    ? `cron ${trigger.schedule.cron} (${trigger.timezone})`
    : `once at ${trigger.schedule.at}`;
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
    list_automations: () =>
      Effect.gen(function* () {
        const snapshot = yield* automationsSnapshot;
        const automations = yield* Effect.forEach(snapshot.automations, (automation) =>
          Effect.gen(function* () {
            // Runs are newest first.
            const last = snapshot.runs.find((run) => run.automationId === automation.id);
            return {
              id: automation.id,
              title: automation.title,
              enabled: automation.enabled,
              trigger: describeTrigger(automation),
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
          return yield* invalid("Give cron or at for a scheduled automation.");
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
        const trigger = retime
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
        yield* (yield* requireEngine).dispatch({
          type: "automation.runNow",
          automationId: automation.id,
        });
        return { id: automation.id, title: automation.title };
      }),
  });
});

export const AutomationsToolkitHandlersLive = AutomationsToolkit.toLayer(make);
