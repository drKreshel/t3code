/**
 * The sidebar folder each scheduled task files its runs' chats into. Stored in
 * `fork.sqlite`; the stream pairs each folder with the chats the task's recent
 * runs used, and clients file those chats the way they file ticket chats.
 */
import {
  type SetTaskFolderInput,
  TaskFoldersError,
  type TaskFoldersSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ForkDatabase from "../ForkDatabase.ts";

export class TaskFolders extends Context.Service<
  TaskFolders,
  {
    readonly stream: Stream.Stream<TaskFoldersSnapshot, TaskFoldersError>;
    readonly set: (input: SetTaskFolderInput) => Effect.Effect<void, TaskFoldersError>;
  }
>()("t3/fork/taskFolders/TaskFolders") {}

const asError = (cause: { readonly message: string } | unknown) =>
  new TaskFoldersError({
    message:
      typeof cause === "object" && cause !== null && "message" in cause
        ? String(cause.message)
        : "Task folders failed.",
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const changes = yield* PubSub.unbounded<void>();

  const snapshot: Effect.Effect<TaskFoldersSnapshot, TaskFoldersError> = Effect.gen(function* () {
    const rows = yield* sql<{ readonly task_id: string; readonly folder: string }>`
      SELECT task_id, folder FROM fork_task_folders ORDER BY task_id
    `;
    if (rows.length === 0) return { routes: [] };
    const { tasks } = yield* scheduledTasks.list();
    const { runs } = yield* scheduledTasks.listRuns({});
    const routes = rows.flatMap((row) => {
      const task = tasks.find((candidate) => candidate.id === row.task_id);
      if (!task) return [];
      // Oldest first, so a new run's chat lands at the end of the folder.
      const threadKeys = [
        ...new Set(
          runs
            .filter((run) => run.taskId === task.id)
            .toReversed()
            .map((run) => `${environmentId}:${run.threadId}`),
        ),
      ];
      return [{ taskId: task.id, folder: row.folder, threadKeys }];
    });
    return { routes };
  }).pipe(Effect.mapError(asError));

  /** Recomputed when a folder changes and whenever the task list does, which includes each run. */
  const stream = Stream.merge(
    Stream.fromPubSub(changes),
    scheduledTasks.subscribeList().pipe(
      Stream.mapError(asError),
      Stream.map(() => undefined),
    ),
  ).pipe(
    Stream.mapEffect(() => snapshot),
    Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
  );

  const set = (input: SetTaskFolderInput) =>
    Effect.gen(function* () {
      if (input.folder === null) {
        yield* sql`DELETE FROM fork_task_folders WHERE task_id = ${input.taskId}`;
      } else {
        yield* sql`
          INSERT INTO fork_task_folders (task_id, folder) VALUES (${input.taskId}, ${input.folder})
          ON CONFLICT (task_id) DO UPDATE SET folder = excluded.folder
        `;
      }
      yield* PubSub.publish(changes, undefined);
    }).pipe(Effect.mapError(asError));

  return TaskFolders.of({ stream, set });
});

export const layer = Layer.effect(TaskFolders, make).pipe(Layer.provide(ForkDatabase.layer));

/** In-memory variant for tests. */
export const layerMemory = Layer.effect(TaskFolders, make).pipe(
  Layer.provide(ForkDatabase.ForkDatabaseMemory),
);
