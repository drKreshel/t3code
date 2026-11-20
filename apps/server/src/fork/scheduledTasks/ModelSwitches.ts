/**
 * Pending model switches for thread-bound scheduled tasks, stored in `fork.sqlite`.
 *
 * A bound task runs on its thread's current model. When the task's own model is
 * changed, its next run carries that model once, switching the thread; later runs
 * follow the thread again, so whichever change came last wins.
 */
import type { ScheduledTaskId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as ForkDatabase from "../ForkDatabase.ts";

export class ScheduledTaskModelSwitches extends Context.Service<
  ScheduledTaskModelSwitches,
  {
    /** Ids of tasks whose next run switches their thread's model. */
    readonly pending: () => Effect.Effect<ReadonlySet<ScheduledTaskId>>;
    readonly request: (taskId: ScheduledTaskId) => Effect.Effect<void>;
    readonly clear: (taskId: ScheduledTaskId) => Effect.Effect<void>;
  }
>()("t3/fork/scheduledTasks/ModelSwitches/ScheduledTaskModelSwitches") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A failed read or write only loses the switch; the task itself keeps running.
  const warn = (operation: string) => (cause: Cause.Cause<SqlError.SqlError>) =>
    Effect.logWarning(`Scheduled task model switch ${operation} failed`, cause);

  const pending = Effect.fn("ScheduledTaskModelSwitches.pending")(function* () {
    const rows = yield* sql<{ readonly task_id: ScheduledTaskId }>`
      SELECT task_id FROM fork_scheduled_task_model_switches
    `.pipe(Effect.catchCause((cause) => warn("read")(cause).pipe(Effect.as([]))));
    return new Set(rows.map((row) => row.task_id)) as ReadonlySet<ScheduledTaskId>;
  });

  const request = Effect.fn("ScheduledTaskModelSwitches.request")(function* (
    taskId: ScheduledTaskId,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO fork_scheduled_task_model_switches (task_id, requested_at)
      VALUES (${taskId}, ${now})
      ON CONFLICT (task_id) DO UPDATE SET requested_at = excluded.requested_at
    `.pipe(Effect.asVoid, Effect.catchCause(warn("request")));
  });

  const clear = Effect.fn("ScheduledTaskModelSwitches.clear")(function* (taskId: ScheduledTaskId) {
    yield* sql`DELETE FROM fork_scheduled_task_model_switches WHERE task_id = ${taskId}`.pipe(
      Effect.asVoid,
      Effect.catchCause(warn("clear")),
    );
  });

  return ScheduledTaskModelSwitches.of({ pending, request, clear });
});

const layerWithDatabase = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Layer.effect(ScheduledTaskModelSwitches, make).pipe(Layer.provide(database));

export const layer = layerWithDatabase(ForkDatabase.layer);
export const layerMemory = layerWithDatabase(ForkDatabase.ForkDatabaseMemory);
