import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ForkDatabaseMemory, runForkMigrations } from "./ForkDatabase.ts";

const TestLayer = ForkDatabaseMemory.pipe(Layer.provide(NodeServices.layer));
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fromJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** The memory database is fully migrated; put back what v11 changed so it can run again. */
const rollBackToV10 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM fork_schema_migrations WHERE version = 11`;
  yield* sql`ALTER TABLE fork_board_columns DROP COLUMN move_after_days`;
  yield* sql`ALTER TABLE fork_board_columns DROP COLUMN move_to_column_id`;
  yield* sql`ALTER TABLE fork_board_templates ADD COLUMN automations_json TEXT NOT NULL DEFAULT '[]'`;
});

describe("fork migration 11", () => {
  it.effect("puts a template's enabled ticket sweeps on the column they start from", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* rollBackToV10;

      const sweep = (from: string, enabled: boolean) => ({
        title: "Settle",
        prompt: "",
        trigger: { type: "schedule", schedule: { kind: "cron", cron: "0 6 * * *" } },
        action: { steps: [{ type: "moveStale", from, to: "Settled", olderThanDays: 7 }] },
        enabled,
      });
      const columns = [
        { name: "Todo", color: null },
        { name: "Done", color: "green" },
        { name: "Settled", color: "gray" },
      ];
      yield* sql`INSERT INTO fork_board_templates (id,name,columns_json,automations_json,created_at,updated_at)
        VALUES ('template','Mine',${toJson(columns)},${toJson([sweep("done", true), sweep("Todo", false)])},'2026-10-01','2026-10-01')`;

      yield* runForkMigrations;

      const [template] = yield* sql<{
        columns_json: string;
      }>`SELECT columns_json FROM fork_board_templates WHERE id = 'template'`;
      expect(fromJson(template!.columns_json)).toEqual([
        { name: "Todo", color: null },
        { name: "Done", color: "green", autoMove: { afterDays: 7, toColumn: "Settled" } },
        { name: "Settled", color: "gray" },
      ]);
      const templateColumns = yield* sql<{
        name: string;
      }>`SELECT name FROM pragma_table_info('fork_board_templates')`;
      expect(templateColumns.map((column) => column.name)).not.toContain("automations_json");
    }).pipe(Effect.provide(TestLayer)),
  );
});
