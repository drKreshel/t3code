/**
 * The fork's own SQLite database, `<state dir>/fork.sqlite`.
 *
 * Fork features keep their tables out of `state.sqlite`: upstream numbers its
 * migrations sequentially, and fork migrations in that sequence would conflict
 * on most upstream merges. Fork services get this client through
 * `Layer.provide(ForkDatabase.layer)`, which keeps it private to them; the
 * main `SqlClient` in the runtime is untouched.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { ServerConfig } from "../config.ts";

/**
 * Applied in order, once each. Append only: a shipped entry is never edited,
 * because installs that already ran it will not run it again.
 */
const MIGRATIONS: ReadonlyArray<{ readonly version: number; readonly statements: string[] }> = [
  {
    version: 1,
    statements: [
      `CREATE TABLE fork_boards (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        default_project_key TEXT,
        position REAL NOT NULL,
        ticket_counter INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      )`,
      `CREATE TABLE fork_board_columns (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL REFERENCES fork_boards(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        position REAL NOT NULL
      )`,
      `CREATE TABLE fork_tickets (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL REFERENCES fork_boards(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        column_id TEXT NOT NULL REFERENCES fork_board_columns(id),
        priority TEXT NOT NULL DEFAULT 'none',
        project_key TEXT,
        position REAL NOT NULL,
        attention_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        UNIQUE (board_id, number)
      )`,
      `CREATE TABLE fork_ticket_criteria (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES fork_tickets(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        checked INTEGER NOT NULL DEFAULT 0,
        position REAL NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE fork_ticket_requires (
        ticket_id TEXT NOT NULL REFERENCES fork_tickets(id) ON DELETE CASCADE,
        requires_ticket_id TEXT NOT NULL REFERENCES fork_tickets(id) ON DELETE CASCADE,
        PRIMARY KEY (ticket_id, requires_ticket_id)
      )`,
      `CREATE TABLE fork_ticket_threads (
        thread_key TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES fork_tickets(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        linked_at TEXT NOT NULL
      )`,
      `CREATE TABLE fork_ticket_comments (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES fork_tickets(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        is_handoff INTEGER NOT NULL DEFAULT 0,
        author TEXT NOT NULL,
        created_at TEXT NOT NULL,
        edited_at TEXT
      )`,
      `CREATE TABLE fork_ticket_events (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES fork_tickets(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX fork_board_columns_board ON fork_board_columns(board_id, position)`,
      `CREATE INDEX fork_tickets_column ON fork_tickets(column_id, position)`,
      `CREATE INDEX fork_ticket_criteria_ticket ON fork_ticket_criteria(ticket_id, position)`,
      `CREATE INDEX fork_ticket_threads_ticket ON fork_ticket_threads(ticket_id)`,
      `CREATE INDEX fork_ticket_comments_ticket ON fork_ticket_comments(ticket_id, created_at)`,
      `CREATE INDEX fork_ticket_events_ticket ON fork_ticket_events(ticket_id, created_at)`,
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE fork_automations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        trigger_json TEXT NOT NULL,
        action_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        max_runs_per_ticket INTEGER NOT NULL DEFAULT 3,
        last_fired_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE fork_automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES fork_automations(id) ON DELETE CASCADE,
        ticket_id TEXT,
        thread_key TEXT,
        status TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      )`,
      `CREATE TABLE fork_board_hook_state (
        board_id TEXT PRIMARY KEY,
        paused INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE fork_ticket_hook_state (
        ticket_id TEXT PRIMARY KEY,
        reset_at TEXT NOT NULL
      )`,
      `CREATE INDEX fork_automation_runs_automation ON fork_automation_runs(automation_id, created_at)`,
      `CREATE INDEX fork_automation_runs_ticket ON fork_automation_runs(ticket_id, status)`,
      `CREATE INDEX fork_automation_runs_thread ON fork_automation_runs(thread_key)`,
    ],
  },
  {
    version: 3,
    statements: [
      `CREATE TABLE fork_workspace_rules (
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        rules_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, scope_id)
      )`,
      `CREATE TABLE fork_ticket_workspaces (
        ticket_id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        path TEXT NOT NULL,
        repos_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        removed_at TEXT
      )`,
    ],
  },
  {
    // Columns lose their type: status and flags move onto tickets, and
    // behavior moves to automations. Existing data carries over.
    version: 4,
    statements: [
      `ALTER TABLE fork_tickets ADD COLUMN status TEXT NOT NULL DEFAULT 'open'`,
      `ALTER TABLE fork_tickets ADD COLUMN flag_json TEXT`,
      `UPDATE fork_tickets SET status = 'done'
        WHERE column_id IN (SELECT id FROM fork_board_columns WHERE type = 'done')`,
      `UPDATE fork_tickets SET status = 'canceled'
        WHERE column_id IN (SELECT id FROM fork_board_columns WHERE type = 'canceled')`,
      `UPDATE fork_tickets SET flag_json = json_object(
          'level', 'warning', 'reason', COALESCE(attention_reason, 'Needs you'),
          'by', 'user', 'at', updated_at)
        WHERE column_id IN (SELECT id FROM fork_board_columns WHERE type = 'attention')`,
      `ALTER TABLE fork_board_columns ADD COLUMN color TEXT`,
      `UPDATE fork_board_columns SET color = CASE type
          WHEN 'active' THEN 'blue' WHEN 'review' THEN 'violet' WHEN 'attention' THEN 'amber'
          WHEN 'done' THEN 'green' WHEN 'canceled' THEN 'gray' ELSE NULL END`,
      `ALTER TABLE fork_board_columns DROP COLUMN type`,
      `ALTER TABLE fork_tickets DROP COLUMN attention_reason`,
    ],
  },
  {
    // Tickets lose their status: columns are the only states, and Requires is
    // a plain link.
    version: 5,
    statements: [`ALTER TABLE fork_tickets DROP COLUMN status`],
  },
  {
    version: 6,
    statements: [
      `CREATE TABLE fork_board_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        columns_json TEXT NOT NULL,
        automations_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 7,
    statements: [`ALTER TABLE fork_tickets ADD COLUMN folder TEXT`],
  },
  {
    version: 8,
    statements: [
      `ALTER TABLE fork_tickets ADD COLUMN workflow_json TEXT`,
      `ALTER TABLE fork_tickets ADD COLUMN workflow_thread_key TEXT`,
    ],
  },
  {
    // Ticket workflows are gone: flows are agent skills now. Automations keep
    // only schedules, and runs no longer belong to tickets.
    version: 9,
    statements: [
      `DELETE FROM fork_automations
        WHERE json_extract(trigger_json, '$.type') IS NOT 'schedule'
          OR json_extract(action_json, '$.checkout') = 'ticket'
          OR EXISTS (SELECT 1 FROM json_each(action_json, '$.steps')
            WHERE json_extract(value, '$.type') IS NOT 'moveStale')`,
      `UPDATE fork_board_templates SET automations_json = (
        SELECT json_group_array(json(automation.value)) FROM json_each(automations_json) AS automation
          WHERE json_extract(automation.value, '$.trigger.type') = 'schedule'
            AND json_extract(automation.value, '$.action.checkout') IS NOT 'ticket'
            AND NOT EXISTS (SELECT 1 FROM json_each(automation.value, '$.action.steps')
              WHERE json_extract(value, '$.type') IS NOT 'moveStale'))`,
      `ALTER TABLE fork_automations DROP COLUMN max_runs_per_ticket`,
      `DROP INDEX fork_automation_runs_ticket`,
      `ALTER TABLE fork_automation_runs DROP COLUMN ticket_id`,
      `ALTER TABLE fork_tickets DROP COLUMN workflow_json`,
      `ALTER TABLE fork_tickets DROP COLUMN workflow_thread_key`,
      `DROP TABLE fork_board_hook_state`,
      `DROP TABLE fork_ticket_hook_state`,
    ],
  },
  {
    // Small fork-wide settings, one JSON value per key.
    version: 10,
    statements: [
      `CREATE TABLE fork_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      )`,
    ],
  },
  {
    // A column can move tickets left in it for some days on to another column.
    // It replaces scheduled "move stale tickets" automations; the automations
    // themselves move to scheduled tasks in `LegacyAutomations`.
    version: 11,
    statements: [
      `ALTER TABLE fork_board_columns ADD COLUMN move_after_days INTEGER`,
      `ALTER TABLE fork_board_columns ADD COLUMN move_to_column_id TEXT`,
      // Templates carry the move on the column it starts from.
      `UPDATE fork_board_templates SET columns_json = (
        SELECT json_group_array(
          CASE WHEN moved.auto_move IS NULL THEN json(moved.value)
            ELSE json_set(moved.value, '$.autoMove', json(moved.auto_move)) END)
        FROM (
          SELECT col.value, (
            SELECT json_object('afterDays', json_extract(step.value, '$.olderThanDays'),
                'toColumn', json_extract(step.value, '$.to'))
              FROM json_each(fork_board_templates.automations_json) AS automation,
                json_each(automation.value, '$.action.steps') AS step
              WHERE json_extract(automation.value, '$.enabled')
                AND lower(trim(json_extract(step.value, '$.from')))
                  = lower(trim(json_extract(col.value, '$.name')))
              LIMIT 1) AS auto_move
          FROM json_each(fork_board_templates.columns_json) AS col ORDER BY col.key
        ) AS moved
      )`,
      `ALTER TABLE fork_board_templates DROP COLUMN automations_json`,
    ],
  },
];

export const runForkMigrations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `;
  const applied = new Set(
    (yield* sql<{ readonly version: number }>`SELECT version FROM fork_schema_migrations`).map(
      (row) => row.version,
    ),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const statement of migration.statements) {
          yield* sql.unsafe(statement);
        }
        yield* sql`
          INSERT INTO fork_schema_migrations (version, applied_at)
          VALUES (${migration.version}, ${DateTime.formatIso(yield* DateTime.now)})
        `;
      }),
    );
  }
});

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* runForkMigrations;
  }),
);

export const makeForkDatabase = (filename: string) =>
  Layer.provideMerge(
    setup,
    NodeSqliteClient.layer({
      filename,
      spanAttributes: { "db.name": "fork.sqlite", "service.name": "t3code-server" },
    }),
  );

/** In-memory database for tests. */
export const ForkDatabaseMemory = makeForkDatabase(":memory:");

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(stateDir, { recursive: true });
    return makeForkDatabase(path.join(stateDir, "fork.sqlite"));
  }),
);
