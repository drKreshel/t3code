/**
 * Fork: one-off schedules used to store a wall-clock `at` and its timezone.
 * Upstream's one-offs store the instant as `runAt`; this rewrites old rows
 * once, keeping the timezone so forms still show the time where it was picked.
 */
import { fromZonedLocalValue } from "@t3tools/shared/zonedDateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

interface LegacyOnceRow {
  readonly task_id: string;
  readonly schedule_json: string;
}

/** The upstream shape of a stored legacy one-off, or null when it cannot be read. */
export function convertLegacyOnceSchedule(json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { type, at, timezone } = parsed as Record<string, unknown>;
  if (type !== "once" || typeof at !== "string") return null;
  const zone = typeof timezone === "string" && timezone.length > 0 ? timezone : undefined;
  let runAt: Date | null;
  try {
    runAt = fromZonedLocalValue(at, zone);
  } catch {
    return null;
  }
  if (runAt === null) return null;
  return JSON.stringify({
    type: "once",
    runAt: runAt.toISOString(),
    ...(zone === undefined ? {} : { timezone: zone }),
  });
}

export const migrateLegacyOnceSchedules = Effect.fn("ForkScheduledTasks.migrateLegacyOnce")(
  function* (sql: SqlClient.SqlClient) {
    const rows = yield* sql<LegacyOnceRow>`
      SELECT task_id, schedule_json FROM scheduled_tasks
      WHERE json_extract(schedule_json, '$.type') = 'once'
        AND json_extract(schedule_json, '$.at') IS NOT NULL
    `;
    for (const row of rows) {
      const converted = convertLegacyOnceSchedule(row.schedule_json);
      if (converted === null) {
        yield* Effect.logWarning("Leaving a one-off schedule whose time does not parse", {
          taskId: row.task_id,
        });
        continue;
      }
      yield* sql`
        UPDATE scheduled_tasks SET schedule_json = ${converted} WHERE task_id = ${row.task_id}
      `;
    }
  },
);
