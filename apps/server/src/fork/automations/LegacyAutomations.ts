/**
 * One-time move of the fork's automations onto upstream's scheduled tasks, under
 * the same ids so a rerun updates instead of duplicating. Past one-offs are
 * dropped; the automation tables are dropped once everything has moved.
 */
import {
  DEFAULT_MODEL,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ScheduledTaskId,
  type ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import { forkParked } from "../../serverActivation.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { BoardsService } from "../boards/BoardsService.ts";
import * as ForkDatabase from "../ForkDatabase.ts";

const LegacyTrigger = Schema.Struct({
  schedule: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("once"), at: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("cron"), cron: Schema.String }),
  ]),
  timezone: Schema.String,
});

const LegacyAction = Schema.Struct({
  projectKey: Schema.NullOr(Schema.String),
  modelSelection: Schema.NullOr(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  checkout: Schema.Literals(["local", "worktree"]),
  steps: Schema.optional(
    Schema.Array(
      Schema.Struct({
        from: Schema.String,
        to: Schema.String,
        olderThanDays: Schema.Int,
        boardId: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const decodeTrigger = Schema.decodeUnknownOption(Schema.fromJsonString(LegacyTrigger));
const decodeAction = Schema.decodeUnknownOption(Schema.fromJsonString(LegacyAction));

interface LegacyRow {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly trigger_json: string;
  readonly action_json: string;
  readonly enabled: number;
}

/** A legacy one-off's instant as scheduled tasks store it. */
export function onceRunAt(at: string, timezone: string): string | null {
  const zoned = DateTime.makeZoned(at, { timeZone: timezone });
  return Option.isNone(zoned) ? null : DateTime.formatIso(zoned.value);
}

/** Moves every automation, then drops the automation tables. A no-op once they are gone. */
export const migrateLegacyAutomations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fork_automations'
  `;
  if (tables.length === 0) return;

  const boards = yield* BoardsService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;

  const rows = yield* sql<LegacyRow>`
    SELECT id, title, prompt, trigger_json, action_json, enabled FROM fork_automations
  `;
  for (const row of rows) {
    const trigger = decodeTrigger(row.trigger_json);
    const action = decodeAction(row.action_json);
    if (Option.isNone(trigger) || Option.isNone(action)) {
      yield* Effect.logWarning("Dropping an automation that no longer decodes", { id: row.id });
      continue;
    }
    const steps = action.value.steps ?? [];
    if (steps.length > 0) {
      if (row.enabled === 0) continue;
      const snapshot = yield* boards.snapshot;
      for (const step of steps) {
        for (const board of snapshot.boards) {
          if (board.archivedAt !== null) continue;
          if (step.boardId && step.boardId !== board.id) continue;
          const named = (name: string) =>
            board.columns.find(
              (column) => column.name.trim().toLowerCase() === name.trim().toLowerCase(),
            );
          const from = named(step.from);
          const to = named(step.to);
          if (!from || !to || from.id === to.id || from.autoMove !== null) continue;
          yield* boards.dispatch(
            {
              type: "column.update",
              columnId: from.id,
              autoMove: { afterDays: Math.max(1, step.olderThanDays), toColumnId: to.id },
            },
            "system",
          );
        }
      }
      continue;
    }

    const { schedule: legacy, timezone } = trigger.value;
    const runAt = legacy.kind === "once" ? onceRunAt(legacy.at, timezone) : null;
    const schedule: ScheduledTaskUpsertSchedule | null =
      legacy.kind === "cron"
        ? { type: "cron", expression: legacy.cron, timezone }
        : runAt === null
          ? null
          : { type: "once", runAt, timezone };
    if (schedule === null) {
      yield* Effect.logWarning("Dropping an automation whose time does not parse", { id: row.id });
      continue;
    }
    const projectKey = action.value.projectKey;
    const separator = projectKey?.indexOf(":") ?? -1;
    if (projectKey === null || projectKey.slice(0, separator) !== environmentId) {
      yield* Effect.logWarning("Dropping an automation without a project here", { id: row.id });
      continue;
    }
    const projectId = ProjectId.make(projectKey.slice(separator + 1));
    const project = yield* projects.getShell(projectId).pipe(Effect.map(Option.getOrUndefined));
    if (!project || !row.prompt.trim()) {
      yield* Effect.logWarning("Dropping an automation whose project is gone", { id: row.id });
      continue;
    }
    const settings = yield* settingsService.getSettings;
    const modelSelection: ModelSelection = action.value.modelSelection ??
      resolveProjectSettings(settings, projectId, project).settings.defaultModelSelection ??
      settings.defaultModelSelection ?? {
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_MODEL,
      };
    yield* scheduledTasks
      .upsert({
        id: ScheduledTaskId.make(row.id),
        title: row.title,
        prompt: row.prompt,
        enabled: row.enabled !== 0,
        schedule,
        projectId,
        workspaceStrategy:
          action.value.checkout === "worktree"
            ? { type: "worktree", baseRef: "HEAD" }
            : { type: "root" },
        modelSelection,
        runtimeMode: action.value.runtimeMode,
        interactionMode: action.value.interactionMode,
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(
        // A one-off already past, or a schedule scheduled tasks refuse: drop it, keep the rest.
        Effect.catch((error) =>
          Effect.logWarning("Dropping an automation scheduled tasks refused", {
            id: row.id,
            reason: error.message,
          }),
        ),
      );
  }

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DROP TABLE IF EXISTS fork_automation_runs`;
      yield* sql`DROP TABLE fork_automations`;
    }),
  );
  yield* Effect.logInfo("Moved fork automations to scheduled tasks", { count: rows.length });
});

export const layer = Layer.effectDiscard(
  forkParked(
    migrateLegacyAutomations.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Moving fork automations to scheduled tasks failed", { cause }),
      ),
    ),
  ),
).pipe(Layer.provide(ForkDatabase.layer));
