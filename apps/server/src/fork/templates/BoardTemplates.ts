/**
 * Board templates: the built-in ones plus those saved in `fork.sqlite`.
 * Creating a board from a template creates the board with its columns.
 */
import {
  BoardsCommandError,
  type BoardTemplate,
  ColumnSpec,
  type TemplatesCommand,
  type TemplatesCommandResult,
  type TemplatesSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { type BoardsActor, BoardsService } from "../boards/BoardsService.ts";
import * as ForkDatabase from "../ForkDatabase.ts";
import { BUILT_IN_TEMPLATES, templateColumnsOf } from "./templateLogic.ts";

const ColumnsJson = Schema.fromJsonString(Schema.Array(ColumnSpec));
const decodeColumns = Schema.decodeUnknownSync(ColumnsJson);
const encodeColumns = Schema.encodeSync(ColumnsJson);

export class BoardTemplates extends Context.Service<
  BoardTemplates,
  {
    readonly snapshot: Effect.Effect<TemplatesSnapshot, BoardsCommandError>;
    readonly stream: Stream.Stream<TemplatesSnapshot, BoardsCommandError>;
    readonly dispatch: (
      command: TemplatesCommand,
      actor: BoardsActor,
    ) => Effect.Effect<TemplatesCommandResult, BoardsCommandError>;
  }
>()("t3/fork/templates/BoardTemplates") {}

interface TemplateRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly columns_json: string;
}

const fail = (code: BoardsCommandError["code"], message: string) =>
  Effect.fail(new BoardsCommandError({ code, message }));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const boards = yield* BoardsService;
  const changes = yield* PubSub.unbounded<void>();

  const storage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new BoardsCommandError({
            code: "storage",
            message: cause instanceof Error ? cause.message : "Templates storage failed.",
          }),
      ),
    );

  const snapshot = storage(
    sql<TemplateRow>`SELECT * FROM fork_board_templates ORDER BY name COLLATE NOCASE`.pipe(
      Effect.map((rows): TemplatesSnapshot => ({
        templates: [
          ...BUILT_IN_TEMPLATES,
          ...rows.map((row): BoardTemplate => ({
            id: row.id,
            name: row.name,
            description: row.description,
            builtIn: false,
            columns: decodeColumns(row.columns_json),
          })),
        ],
      })),
    ),
  );

  const dispatch = (command: TemplatesCommand, actor: BoardsActor) =>
    Effect.gen(function* () {
      switch (command.type) {
        case "board.create": {
          const { templates } = yield* snapshot;
          const template = templates.find((candidate) => candidate.id === command.templateId);
          if (!template) return yield* fail("not-found", "That template no longer exists.");
          return yield* boards.dispatch(
            {
              type: "board.create",
              name: command.name,
              key: command.key,
              ...(command.icon !== undefined ? { icon: command.icon } : {}),
              ...(command.defaultProjectKey !== undefined
                ? { defaultProjectKey: command.defaultProjectKey }
                : {}),
              columns: template.columns,
            },
            actor,
          );
        }
        case "template.save": {
          if (BUILT_IN_TEMPLATES.some((template) => template.name === command.name)) {
            return yield* fail("invalid", `"${command.name}" is a built-in template's name.`);
          }
          const board = (yield* boards.snapshot).boards.find(
            (candidate) => candidate.id === command.boardId,
          );
          if (!board) return yield* fail("not-found", "That board no longer exists.");
          const at = DateTime.formatIso(yield* DateTime.now);
          const existing = yield* storage(
            sql<{ readonly id: string }>`
              SELECT id FROM fork_board_templates WHERE name = ${command.name}
            `,
          );
          const id = existing[0]?.id ?? (yield* storage(crypto.randomUUIDv4));
          yield* storage(sql`
            INSERT INTO fork_board_templates
              (id, name, description, columns_json, created_at, updated_at)
            VALUES (${id}, ${command.name}, ${command.description ?? ""},
              ${encodeColumns(templateColumnsOf(board))}, ${at}, ${at})
            ON CONFLICT (id) DO UPDATE SET
              description = excluded.description,
              columns_json = excluded.columns_json,
              updated_at = excluded.updated_at
          `);
          yield* PubSub.publish(changes, undefined);
          return { id };
        }
        case "template.delete": {
          if (BUILT_IN_TEMPLATES.some((template) => template.id === command.templateId)) {
            return yield* fail("invalid", "Built-in templates cannot be deleted.");
          }
          yield* storage(sql`DELETE FROM fork_board_templates WHERE id = ${command.templateId}`);
          yield* PubSub.publish(changes, undefined);
          return { id: null };
        }
      }
    });

  // One-slot sliding mailbox per subscriber, as for boards: snapshots are whole states.
  const stream = Stream.callback<TemplatesSnapshot, BoardsCommandError>(
    (mailbox) =>
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        Queue.offerUnsafe(mailbox, yield* snapshot);
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach(() =>
            snapshot.pipe(
              Effect.matchEffect({
                onFailure: (error) => Queue.fail(mailbox, error),
                onSuccess: (next) => Effect.sync(() => Queue.offerUnsafe(mailbox, next)),
              }),
            ),
          ),
          Effect.forkScoped,
        );
      }),
    { bufferSize: 1, strategy: "sliding" },
  );

  return BoardTemplates.of({ snapshot, stream, dispatch });
});

export const layer = Layer.effect(BoardTemplates, make).pipe(Layer.provide(ForkDatabase.layer));

/** In-memory variant for tests. */
export const layerMemory = Layer.effect(BoardTemplates, make).pipe(
  Layer.provide(ForkDatabase.ForkDatabaseMemory),
);
