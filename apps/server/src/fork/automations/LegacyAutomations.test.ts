import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type OrchestrationProjectShell,
  ProjectId,
  ProviderInstanceId,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import { ScheduledTaskService } from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { BoardsService, layerMemory as boardsLayerMemory } from "../boards/BoardsService.ts";
import { ForkDatabaseMemory } from "../ForkDatabase.ts";
import { migrateLegacyAutomations, onceWallClock } from "./LegacyAutomations.ts";

const ENVIRONMENT_ID = EnvironmentId.make("env-1");
const PROJECT_ID = ProjectId.make("project-1");
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("onceWallClock", () => {
  it("reads a one-off's instant as wall-clock time in its zone", () => {
    expect(onceWallClock("2026-10-09T16:00:00.000Z", "America/Vancouver")).toBe("2026-10-09T09:00");
    expect(onceWallClock("not a date", "UTC")).toBeNull();
  });
});

describe("migrateLegacyAutomations", () => {
  it.effect("moves chats to scheduled tasks and sweeps to columns, then drops the tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const boards = yield* BoardsService;
      const upserts = yield* Ref.make<ReadonlyArray<ScheduledTaskUpsertInput>>([]);

      yield* boards.dispatch({ type: "board.create", name: "Atlas", key: "ATLAS" }, "user");
      const chat = {
        projectKey: `${ENVIRONMENT_ID}:${PROJECT_ID}`,
        modelSelection: null,
        runtimeMode: "full-access",
        interactionMode: "default",
        checkout: "local",
      };
      const daily = (cron: string) => ({
        type: "schedule",
        schedule: { kind: "cron", cron },
        timezone: "America/Vancouver",
      });
      const rows: ReadonlyArray<readonly [string, string, object, object, number]> = [
        ["update", "Update T3 Code.", daily("0 4 * * *"), chat, 1],
        ["monthly", "Monthly report.", daily("0 9 1 * *"), { ...chat, checkout: "worktree" }, 1],
        [
          "once",
          "Just once.",
          {
            type: "schedule",
            schedule: { kind: "once", at: "2026-10-09T09:00:00Z" },
            timezone: "UTC",
          },
          chat,
          1,
        ],
        [
          "settle",
          "",
          daily("0 6 * * *"),
          {
            ...chat,
            projectKey: null,
            steps: [{ type: "moveStale", from: "done", to: "Backlog", olderThanDays: 7 }],
          },
          1,
        ],
        [
          "paused-settle",
          "",
          daily("0 6 * * *"),
          {
            ...chat,
            projectKey: null,
            steps: [{ type: "moveStale", from: "Review", to: "Backlog", olderThanDays: 3 }],
          },
          0,
        ],
      ];
      for (const [id, prompt, trigger, action, enabled] of rows) {
        yield* sql`INSERT INTO fork_automations (id,title,prompt,trigger_json,action_json,enabled,created_at,updated_at)
          VALUES (${id},${id},${prompt},${toJson(trigger)},${toJson(action)},${enabled},'2026-10-01','2026-10-01')`;
      }

      const fakes = Layer.mergeAll(
        Layer.mock(ScheduledTaskService)({
          upsert: (input) =>
            Ref.update(upserts, (list) => [...list, input]).pipe(Effect.as({ task: {} as never })),
        }),
        Layer.mock(ProjectStoreV2)({
          getShell: (projectId) =>
            Effect.succeed(
              projectId === PROJECT_ID
                ? Option.some({ id: PROJECT_ID } as OrchestrationProjectShell)
                : Option.none(),
            ),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
        }),
      );
      yield* migrateLegacyAutomations.pipe(Effect.provide(fakes));
      // Nothing left to move.
      yield* migrateLegacyAutomations.pipe(Effect.provide(fakes));

      const tasks = yield* Ref.get(upserts);
      expect(tasks).toHaveLength(3);
      // Schedules carry over exactly, in their own timezone.
      expect(tasks[0]).toMatchObject({
        id: "update",
        prompt: "Update T3 Code.",
        enabled: true,
        schedule: { type: "cron", expression: "0 4 * * *", timezone: "America/Vancouver" },
        projectId: PROJECT_ID,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex") },
      });
      expect(tasks[1]).toMatchObject({
        id: "monthly",
        enabled: true,
        schedule: { type: "cron", expression: "0 9 1 * *" },
        workspaceStrategy: { type: "worktree", baseRef: "HEAD" },
      });
      expect(tasks[2]).toMatchObject({
        id: "once",
        schedule: { type: "once", at: "2026-10-09T09:00", timezone: "UTC" },
      });

      const columns = (yield* boards.snapshot).boards[0]!.columns;
      const column = (name: string) => columns.find((candidate) => candidate.name === name)!;
      expect(column("Done").autoMove).toEqual({ afterDays: 7, toColumnId: column("Backlog").id });
      expect(column("Review").autoMove).toBeNull();

      const tables = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fork_automation%'`;
      expect(tables).toEqual([]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(boardsLayerMemory, ForkDatabaseMemory).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
