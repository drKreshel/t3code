/** Filtering and sorting the Scheduled Tasks page's runs table. Pure, so the page stays dumb. */
import type { ScheduledTaskRun, ScheduledTaskRunState } from "@t3tools/contracts";

export type RunSortKey = "started" | "duration" | "status" | "task";
export interface RunSort {
  readonly key: RunSortKey;
  readonly descending: boolean;
}

export interface RunFilter {
  readonly taskId: string | null;
  readonly state: ScheduledTaskRunState | null;
  readonly projectId: string | null;
}

export const NO_RUN_FILTER: RunFilter = { taskId: null, state: null, projectId: null };
export const DEFAULT_RUN_SORT: RunSort = { key: "started", descending: true };

/** Ordered as a person scans for trouble: failures first when sorting by status. */
const STATE_ORDER: Record<ScheduledTaskRunState, number> = {
  failed: 0,
  stopped: 1,
  running: 2,
  queued: 3,
  succeeded: 4,
};

/** Milliseconds a run took, or has taken so far while it is still going. */
export function runDurationMs(run: ScheduledTaskRun, nowMs: number): number {
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt === null ? nowMs : Date.parse(run.finishedAt);
  return Math.max(0, end - start);
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function visibleRuns(
  runs: ReadonlyArray<ScheduledTaskRun>,
  filter: RunFilter,
  sort: RunSort,
  taskTitle: (taskId: string) => string,
  nowMs: number,
): ReadonlyArray<ScheduledTaskRun> {
  const filtered = runs.filter(
    (run) =>
      (filter.taskId === null || run.taskId === filter.taskId) &&
      (filter.state === null || run.state === filter.state) &&
      (filter.projectId === null || run.projectId === filter.projectId),
  );
  const compare = (a: ScheduledTaskRun, b: ScheduledTaskRun): number => {
    switch (sort.key) {
      case "started":
        return Date.parse(a.startedAt) - Date.parse(b.startedAt);
      case "duration":
        return runDurationMs(a, nowMs) - runDurationMs(b, nowMs);
      case "status":
        return STATE_ORDER[a.state] - STATE_ORDER[b.state];
      case "task":
        return taskTitle(a.taskId).localeCompare(taskTitle(b.taskId));
    }
  };
  // Ties keep the newest run first.
  return filtered.toSorted(
    (a, b) =>
      (sort.descending ? -1 : 1) * compare(a, b) ||
      Date.parse(b.startedAt) - Date.parse(a.startedAt),
  );
}

/** Clicking a column sorts by it; clicking it again flips the direction. */
export function toggleSort(current: RunSort, key: RunSortKey): RunSort {
  if (current.key === key) return { key, descending: !current.descending };
  return { key, descending: key === "started" || key === "duration" };
}
