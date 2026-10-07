/**
 * Chat pins, stored in `fork.sqlite`: each thread's pinned files, URLs, and notes.
 *
 * Every write publishes the thread it changed; subscribers to that thread
 * reload its whole (small) pin set.
 */
import {
  THREAD_PINS_MAX,
  type ThreadId,
  type ThreadPins,
  type ThreadPinsCommand,
  ThreadPinsError,
  type ThreadPinsErrorCode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ForkDatabase from "../ForkDatabase.ts";

export class ThreadPinsService extends Context.Service<
  ThreadPinsService,
  {
    readonly get: (threadId: ThreadId) => Effect.Effect<ThreadPins, ThreadPinsError>;
    readonly stream: (threadId: ThreadId) => Stream.Stream<ThreadPins, ThreadPinsError>;
    /** Applies one command and returns the thread's pins after it. */
    readonly dispatch: (command: ThreadPinsCommand) => Effect.Effect<ThreadPins, ThreadPinsError>;
  }
>()("t3/fork/threadPins/ThreadPinsService") {}

/** An absolute host path (POSIX or Windows) or an http(s) URL. */
export const isPinTarget = (target: string) =>
  target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target) || /^https?:\/\/\S+$/i.test(target);

const fail = (code: ThreadPinsErrorCode, message: string) =>
  Effect.fail(new ThreadPinsError({ code, message }));

const toPinsError = (error: unknown): ThreadPinsError =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly _tag?: unknown })._tag === "ThreadPinsError"
    ? (error as ThreadPinsError)
    : new ThreadPinsError({
        code: "storage",
        message: error instanceof Error ? error.message : String(error),
      });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const changes = yield* PubSub.unbounded<ThreadId>();
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const load = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly id: string;
        readonly title: string;
        readonly target: string | null;
        readonly text: string | null;
        readonly created_at: string;
        readonly updated_at: string;
      }>`SELECT id, title, target, text, created_at, updated_at FROM fork_thread_pins
        WHERE thread_id = ${threadId} ORDER BY rowid`;
      return {
        threadId,
        pins: rows.map((row) => ({
          id: row.id,
          title: row.title,
          target: row.target,
          text: row.text,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      } satisfies ThreadPins;
    }).pipe(Effect.mapError(toPinsError));

  const assertRoom = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const [count] = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM fork_thread_pins WHERE thread_id = ${threadId}`;
      if ((count?.n ?? 0) >= THREAD_PINS_MAX)
        return yield* fail(
          "invalid",
          `A chat holds at most ${THREAD_PINS_MAX} pins. Unpin one first.`,
        );
    });

  const run = (command: ThreadPinsCommand) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      switch (command.type) {
        case "note.set": {
          // A note keeps its place in the list when its text changes.
          const existing = yield* sql<{ readonly id: string }>`
            SELECT id FROM fork_thread_pins
            WHERE thread_id = ${command.threadId} AND target IS NULL AND title = ${command.title}`;
          const id = existing[0]?.id;
          if (id !== undefined) {
            yield* sql`UPDATE fork_thread_pins SET text = ${command.text}, updated_at = ${now}
              WHERE id = ${id}`;
            return;
          }
          yield* assertRoom(command.threadId);
          yield* sql`
            INSERT INTO fork_thread_pins (id, thread_id, title, target, text, created_at, updated_at)
            VALUES (${yield* crypto.randomUUIDv4}, ${command.threadId}, ${command.title}, NULL,
              ${command.text}, ${now}, ${now})`;
          return;
        }
        case "pin.add": {
          if (!isPinTarget(command.target))
            return yield* fail("invalid", "Pin an absolute file path or an http(s) URL.");
          const existing = yield* sql<{ readonly id: string }>`
            SELECT id FROM fork_thread_pins
            WHERE thread_id = ${command.threadId} AND target = ${command.target}`;
          const id = existing[0]?.id;
          if (id !== undefined) {
            yield* sql`UPDATE fork_thread_pins SET title = ${command.title}, updated_at = ${now}
              WHERE id = ${id}`;
            return;
          }
          yield* assertRoom(command.threadId);
          yield* sql`
            INSERT INTO fork_thread_pins (id, thread_id, title, target, text, created_at, updated_at)
            VALUES (${yield* crypto.randomUUIDv4}, ${command.threadId}, ${command.title},
              ${command.target}, NULL, ${now}, ${now})`;
          return;
        }
        case "pin.remove": {
          const removed = yield* sql<{ readonly id: string }>`
            DELETE FROM fork_thread_pins
            WHERE thread_id = ${command.threadId} AND id = ${command.pinId} RETURNING id`;
          if (removed.length === 0) return yield* fail("not-found", "That pin no longer exists.");
          return;
        }
      }
    });

  const dispatch = (command: ThreadPinsCommand) =>
    sql
      .withTransaction(run(command))
      .pipe(
        Effect.mapError(toPinsError),
        Effect.andThen(PubSub.publish(changes, command.threadId)),
        Effect.andThen(load(command.threadId)),
      );

  // One-slot sliding mailbox: each emission is the whole state, so a slow
  // socket skipping intermediate ones is safe.
  const stream = (threadId: ThreadId) =>
    Stream.callback<ThreadPins, ThreadPinsError>(
      (mailbox) =>
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          Queue.offerUnsafe(mailbox, yield* load(threadId));
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === threadId),
            Stream.runForEach(() =>
              load(threadId).pipe(
                Effect.matchEffect({
                  onFailure: (error) => Queue.fail(mailbox, error),
                  onSuccess: (pins) => Effect.sync(() => Queue.offerUnsafe(mailbox, pins)),
                }),
              ),
            ),
            Effect.forkScoped,
          );
        }),
      { bufferSize: 1, strategy: "sliding" },
    );

  return ThreadPinsService.of({ get: load, stream, dispatch });
});

/** Uses its own `fork.sqlite` client; the runtime's main database is not visible here. */
export const layer = Layer.effect(ThreadPinsService, make).pipe(Layer.provide(ForkDatabase.layer));

/** In-memory variant for tests. */
export const layerMemory = Layer.effect(ThreadPinsService, make).pipe(
  Layer.provide(ForkDatabase.ForkDatabaseMemory),
);
