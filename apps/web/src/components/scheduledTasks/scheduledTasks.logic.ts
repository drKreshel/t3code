/** Searching, filtering, and sorting the Scheduled Tasks list and a task's runs. Pure, so the pages stay dumb. */
import type { ScheduledTask, ScheduledTaskRun, ScheduledTaskRunState } from "@t3tools/contracts";

export interface Sort<Key extends string> {
  readonly key: Key;
  readonly descending: boolean;
}

/** Clicking a column sorts by it; clicking it again flips the direction. Times and counts start newest or largest. */
export function toggleSort<Key extends string>(
  current: Sort<Key>,
  key: Key,
  descendingFirst: ReadonlyArray<Key>,
): Sort<Key> {
  if (current.key === key) return { key, descending: !current.descending };
  return { key, descending: descendingFirst.includes(key) };
}

/** Every word of the query appears somewhere in the haystack, ignoring case. */
export function matchesQuery(query: string, haystack: ReadonlyArray<string>): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = haystack.join("\n").toLowerCase();
  return words.every((word) => text.includes(word));
}

/** Missing values sort last in both directions, so "never ran" never crowds the top. */
function compareWithMissingLast(
  a: number | string | null,
  b: number | string | null,
  descending: boolean,
): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const order = typeof a === "string" ? a.localeCompare(b as string) : a - (b as number);
  return descending ? -order : order;
}

// Tasks

export type TaskSortKey = "title" | "project" | "lastRun" | "nextRun" | "runs";
export const DEFAULT_TASK_SORT: Sort<TaskSortKey> = { key: "title", descending: false };
export const TASK_SORT_DESCENDING_FIRST: ReadonlyArray<TaskSortKey> = ["lastRun", "runs"];

export interface TaskFilter {
  readonly query: string;
  readonly projectId: string | null;
}

/** What the list shows for a task beyond the task itself, which search also reads. */
export interface TaskLabels {
  readonly project: string;
  readonly schedule: string;
  readonly folder: string;
  readonly model: string;
}

export function visibleTasks(
  tasks: ReadonlyArray<ScheduledTask>,
  filter: TaskFilter,
  sort: Sort<TaskSortKey>,
  labels: (task: ScheduledTask) => TaskLabels,
): ReadonlyArray<ScheduledTask> {
  const filtered = tasks.filter((task) => {
    if (filter.projectId !== null && task.projectId !== filter.projectId) return false;
    const label = labels(task);
    return matchesQuery(filter.query, [
      task.title,
      task.prompt,
      label.project,
      label.schedule,
      label.folder,
      label.model,
    ]);
  });
  const value = (task: ScheduledTask): number | string | null => {
    switch (sort.key) {
      case "title":
        return task.title;
      case "project":
        return labels(task).project;
      case "lastRun":
        return task.lastRunAt === null ? null : Date.parse(task.lastRunAt);
      case "nextRun":
        return task.enabled && task.nextRunAt !== null ? Date.parse(task.nextRunAt) : null;
      case "runs":
        return task.runCount;
    }
  };
  return filtered.toSorted(
    (a, b) =>
      compareWithMissingLast(value(a), value(b), sort.descending) || a.title.localeCompare(b.title),
  );
}

// Runs

export type RunSortKey = "chat" | "started" | "duration" | "status";
export const DEFAULT_RUN_SORT: Sort<RunSortKey> = { key: "started", descending: true };
export const RUN_SORT_DESCENDING_FIRST: ReadonlyArray<RunSortKey> = ["started", "duration"];

export interface RunFilter {
  readonly query: string;
  readonly state: ScheduledTaskRunState | null;
}

export const NO_RUN_FILTER: RunFilter = { query: "", state: null };

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
  sort: Sort<RunSortKey>,
  nowMs: number,
): ReadonlyArray<ScheduledTaskRun> {
  const filtered = runs.filter(
    (run) =>
      (filter.state === null || run.state === filter.state) &&
      matchesQuery(filter.query, [run.threadTitle, run.state]),
  );
  const compare = (a: ScheduledTaskRun, b: ScheduledTaskRun): number => {
    switch (sort.key) {
      case "chat":
        return a.threadTitle.localeCompare(b.threadTitle);
      case "started":
        return Date.parse(a.startedAt) - Date.parse(b.startedAt);
      case "duration":
        return runDurationMs(a, nowMs) - runDurationMs(b, nowMs);
      case "status":
        return STATE_ORDER[a.state] - STATE_ORDER[b.state];
    }
  };
  // Ties keep the newest run first.
  return filtered.toSorted(
    (a, b) =>
      (sort.descending ? -1 : 1) * compare(a, b) ||
      Date.parse(b.startedAt) - Date.parse(a.startedAt),
  );
}
