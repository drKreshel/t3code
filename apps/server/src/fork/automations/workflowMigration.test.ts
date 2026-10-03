import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { AutomationAction, AutomationTrigger, TicketWorkflow } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ForkDatabaseMemory, runForkMigrations } from "../ForkDatabase.ts";
import { migrateColumnWorkflows } from "./workflowMigration.ts";

const TestLayer = ForkDatabaseMemory.pipe(Layer.provide(NodeServices.layer));
const decodeWorkflow = Schema.decodeUnknownSync(Schema.fromJsonString(TicketWorkflow));
const decodeTrigger = Schema.decodeUnknownSync(Schema.fromJsonString(AutomationTrigger));
const ActionJson = Schema.fromJsonString(AutomationAction);
const encodeAction = Schema.encodeSync(ActionJson);
const decodeAction = Schema.decodeUnknownSync(ActionJson);

describe("workflow migration", () => {
  it.effect(
    "keeps hook instructions and history, assigns a combined workflow, and preserves schedules",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO fork_boards (id,key,name,position,created_at,updated_at) VALUES ('board','WEB','Web',1,'2026-10-01','2026-10-01')`;
        yield* sql`INSERT INTO fork_board_columns (id,board_id,name,position) VALUES ('implement','board','In Progress',1), ('review','board','Review',2)`;
        yield* sql`INSERT INTO fork_tickets (id,board_id,number,title,column_id,position,created_at,updated_at)
      VALUES ('ticket','board',1,'Fix layout','implement',1,'2026-10-01','2026-10-01')`;
        const action =
          '{"projectKey":null,"modelSelection":null,"runtimeMode":"full-access","interactionMode":"default","checkout":"ticket"}';
        // Deliberately insert review first: workflow order follows columns, not insertion order.
        yield* sql`INSERT INTO fork_automations (id,title,prompt,trigger_json,action_json,created_at,updated_at)
      VALUES ('review-hook','Review','Review carefully.','{"type":"board","boardId":"board","columnId":"review"}',${action},'2026-10-01','2026-10-01'),
        ('implement-hook','Implement','Implement the change.','{"type":"board","boardId":"board","columnId":"implement"}',${action},'2026-10-01','2026-10-01'),
        ('schedule','Cleanup','Cleanup.','{"type":"schedule","schedule":{"kind":"cron","cron":"0 6 * * *"},"timezone":"UTC"}',${action},'2026-10-01','2026-10-01')`;
        yield* sql`INSERT INTO fork_automation_runs (id,automation_id,ticket_id,thread_key,status,created_at)
      VALUES ('active','implement-hook','ticket','env:existing','running','2026-10-01'), ('queued','review-hook','ticket',NULL,'queued','2026-10-01')`;
        yield* migrateColumnWorkflows;
        const presets = yield* sql<{
          id: string;
          prompt: string;
          trigger_json: string;
        }>`SELECT * FROM fork_automations`;
        expect(presets.find((preset) => preset.id === "implement-hook")?.prompt).toBe(
          "Implement the change.",
        );
        expect(
          decodeTrigger(presets.find((preset) => preset.id === "implement-hook")!.trigger_json)
            .type,
        ).toBe("workflow");
        expect(
          decodeTrigger(presets.find((preset) => preset.id === "schedule")!.trigger_json).type,
        ).toBe("schedule");
        const [ticket] = yield* sql<{
          workflow_json: string;
          workflow_thread_key: string;
        }>`SELECT * FROM fork_tickets WHERE id = 'ticket'`;
        const workflow = decodeWorkflow(ticket!.workflow_json);
        expect(workflow.prompt.indexOf("Implement the change.")).toBeLessThan(
          workflow.prompt.indexOf("Review carefully."),
        );
        expect(ticket!.workflow_thread_key).toBe("env:existing");
        expect(
          (yield* sql<{
            status: string;
          }>`SELECT status FROM fork_automation_runs WHERE id = 'active'`)[0]?.status,
        ).toBe("running");
        expect(
          (yield* sql<{
            status: string;
          }>`SELECT status FROM fork_automation_runs WHERE id = 'queued'`)[0]?.status,
        ).toBe("skipped");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("seeds presets once and never reapplies the migration to an edited ticket", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const before = yield* sql<{ id: string }>`SELECT id FROM fork_automations`;
      yield* runForkMigrations;
      const after = yield* sql<{ id: string }>`SELECT id FROM fork_automations`;
      expect(after).toEqual(before);
      expect(after.map((preset) => preset.id)).toEqual(
        expect.arrayContaining([
          "builtin:simple-fix",
          "builtin:feature-workflow",
          "builtin:review-only",
        ]),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("turns legacy ticket steps into instructions instead of executable actions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const action = encodeAction({
        projectKey: null,
        modelSelection: null,
        runtimeMode: "full-access",
        interactionMode: "default",
        checkout: "ticket",
        steps: [{ type: "moveTo", column: "Done" }, { type: "removeWorkspace" }],
      });
      yield* sql`INSERT INTO fork_automations (id,title,prompt,trigger_json,action_json,created_at,updated_at)
        VALUES ('old-steps','Close','','{"type":"board","boardId":null,"columnId":null,"columnName":"Close"}',${action},'2026-10-01','2026-10-01')`;
      yield* migrateColumnWorkflows;
      const [preset] = yield* sql<{
        prompt: string;
        action_json: string;
        trigger_json: string;
      }>`SELECT * FROM fork_automations WHERE id = 'old-steps'`;
      expect(decodeTrigger(preset!.trigger_json).type).toBe("workflow");
      expect(preset!.prompt).toContain("Move the ticket to Done.");
      expect(preset!.prompt).toContain(
        "Remove the ticket workspace once its work is saved and delivered.",
      );
      expect(decodeAction(preset!.action_json)).not.toHaveProperty("steps");
    }).pipe(Effect.provide(TestLayer)),
  );
});
