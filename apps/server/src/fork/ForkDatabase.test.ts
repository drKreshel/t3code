import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { AutomationAction, AutomationTrigger, TemplateAutomation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ForkDatabaseMemory, runForkMigrations } from "./ForkDatabase.ts";

const TestLayer = ForkDatabaseMemory.pipe(Layer.provide(NodeServices.layer));
const decodeTrigger = Schema.decodeUnknownSync(Schema.fromJsonString(AutomationTrigger));
const decodeAction = Schema.decodeUnknownSync(Schema.fromJsonString(AutomationAction));
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeTemplateAutomations = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(TemplateAutomation)),
);

/** The memory database is fully migrated; put back what v9 removed so it can run again. */
const rollBackToV8 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM fork_schema_migrations WHERE version = 9`;
  yield* sql`ALTER TABLE fork_automations ADD COLUMN max_runs_per_ticket INTEGER NOT NULL DEFAULT 3`;
  yield* sql`ALTER TABLE fork_automation_runs ADD COLUMN ticket_id TEXT`;
  yield* sql`CREATE INDEX fork_automation_runs_ticket ON fork_automation_runs(ticket_id, status)`;
  yield* sql`ALTER TABLE fork_tickets ADD COLUMN workflow_json TEXT`;
  yield* sql`ALTER TABLE fork_tickets ADD COLUMN workflow_thread_key TEXT`;
  yield* sql`CREATE TABLE fork_board_hook_state (board_id TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0)`;
  yield* sql`CREATE TABLE fork_ticket_hook_state (ticket_id TEXT PRIMARY KEY, reset_at TEXT NOT NULL)`;
});

const columnsOf = (table: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.pipe(
      Effect.map((rows) => rows.map((row) => row.name)),
    ),
  );

describe("fork migration 9", () => {
  it.effect("drops ticket workflows, keeps schedules, and removes workflow columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* rollBackToV8;

      yield* sql`INSERT INTO fork_boards (id,key,name,position,created_at,updated_at) VALUES ('board','WEB','Web',1,'2026-10-01','2026-10-01')`;
      yield* sql`INSERT INTO fork_board_columns (id,board_id,name,position) VALUES ('review','board','Review',1)`;
      yield* sql`INSERT INTO fork_tickets (id,board_id,number,title,column_id,position,created_at,updated_at,workflow_json,workflow_thread_key)
        VALUES ('ticket','board',1,'Fix layout','review',1,'2026-10-01','2026-10-01','{"presetId":"workflow"}','env:owner')`;

      const action = (extra: Record<string, unknown>) => ({
        projectKey: "env:project",
        modelSelection: null,
        runtimeMode: "full-access",
        interactionMode: "default",
        checkout: "local",
        ...extra,
      });
      const schedule =
        '{"type":"schedule","schedule":{"kind":"cron","cron":"0 6 * * *"},"timezone":"UTC"}';
      const moveStale = { type: "moveStale", from: "Done", to: "Settled", olderThanDays: 7 };
      const rows: ReadonlyArray<readonly [id: string, trigger: string, action: object]> = [
        ["chat-schedule", schedule, action({})],
        ["sweep", schedule, action({ steps: [moveStale] })],
        ["workflow", '{"type":"workflow"}', action({ checkout: "ticket" })],
        ["hook", '{"type":"board","boardId":"board","columnId":"review"}', action({})],
        ["ticket-checkout", schedule, action({ checkout: "ticket" })],
        ["legacy-step", schedule, action({ steps: [{ type: "moveTo", column: "Done" }] })],
      ];
      for (const [id, trigger, actionValue] of rows) {
        const actionJson = toJson(actionValue);
        yield* sql`INSERT INTO fork_automations (id,title,prompt,trigger_json,action_json,created_at,updated_at)
          VALUES (${id},${id},'Do it.',${trigger},${actionJson},'2026-10-01','2026-10-01')`;
      }
      yield* sql`INSERT INTO fork_automation_runs (id,automation_id,ticket_id,thread_key,status,created_at)
        VALUES ('schedule-run','chat-schedule',NULL,'env:a','succeeded','2026-10-01'),
          ('workflow-run','workflow','ticket','env:owner','running','2026-10-01'),
          ('hook-run','hook','ticket',NULL,'queued','2026-10-01')`;

      const templateSchedule = {
        title: "Settle",
        prompt: "",
        trigger: {
          type: "schedule",
          schedule: { kind: "cron", cron: "0 3 * * *" },
          timezone: null,
        },
        action: action({ projectKey: null, steps: [moveStale] }),
        enabled: true,
        maxRunsPerTicket: 5,
      };
      const templateHook = {
        ...templateSchedule,
        title: "Verify",
        trigger: { type: "board", column: "Review" },
        action: action({ projectKey: null, checkout: "ticket" }),
      };
      yield* sql`INSERT INTO fork_board_templates (id,name,columns_json,automations_json,created_at,updated_at)
        VALUES ('template','Mine','[]',${toJson([templateHook, templateSchedule])},'2026-10-01','2026-10-01')`;

      yield* runForkMigrations;

      const automations = yield* sql<{
        id: string;
        trigger_json: string;
        action_json: string;
      }>`SELECT id, trigger_json, action_json FROM fork_automations ORDER BY id`;
      expect(automations.map((automation) => automation.id)).toEqual(["chat-schedule", "sweep"]);
      for (const automation of automations) {
        expect(decodeTrigger(automation.trigger_json).type).toBe("schedule");
        expect(decodeAction(automation.action_json).checkout).toBe("local");
      }
      expect(decodeAction(automations[1]!.action_json).steps).toEqual([moveStale]);

      const runs = yield* sql<{ id: string }>`SELECT id FROM fork_automation_runs`;
      expect(runs.map((run) => run.id)).toEqual(["schedule-run"]);

      const [template] = yield* sql<{
        automations_json: string;
      }>`SELECT automations_json FROM fork_board_templates WHERE id = 'template'`;
      expect(
        decodeTemplateAutomations(template!.automations_json).map((entry) => entry.title),
      ).toEqual(["Settle"]);

      const ticketColumns = yield* columnsOf("fork_tickets");
      expect(ticketColumns).not.toContain("workflow_json");
      expect(ticketColumns).not.toContain("workflow_thread_key");
      expect(yield* columnsOf("fork_automations")).not.toContain("max_runs_per_ticket");
      expect(yield* columnsOf("fork_automation_runs")).not.toContain("ticket_id");
      const hookTables = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('fork_board_hook_state', 'fork_ticket_hook_state')`;
      expect(hookTables).toEqual([]);
      expect(
        (yield* sql<{ title: string }>`SELECT title FROM fork_tickets WHERE id = 'ticket'`)[0]
          ?.title,
      ).toBe("Fix layout");
    }).pipe(Effect.provide(TestLayer)),
  );
});
