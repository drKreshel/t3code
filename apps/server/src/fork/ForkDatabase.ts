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
import * as SqlClient from "effect/unstable/sql/SqlClient";
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
