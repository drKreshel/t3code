import {
  MessageId,
  ProjectId,
  type ScheduledTaskRun,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_RUN_SORT,
  NO_RUN_FILTER,
  formatDuration,
  toggleSort,
  visibleRuns,
} from "./scheduledRuns.logic";

const run = (
  id: string,
  taskId: string,
  state: ScheduledTaskRun["state"],
  startedAt: string,
  finishedAt: string | null,
  projectId = "project-1",
): ScheduledTaskRun => ({
  messageId: MessageId.make(id),
  taskId: ScheduledTaskId.make(taskId),
  threadId: ThreadId.make(`chat-${id}`),
  projectId: ProjectId.make(projectId),
  threadTitle: id,
  startedAt,
  finishedAt,
  state,
});

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const runs = [
  run("a", "blog", "succeeded", "2026-10-06T06:00:00.000Z", "2026-10-06T06:10:00.000Z"),
  run("b", "serp", "failed", "2026-10-06T09:15:00.000Z", "2026-10-06T09:16:00.000Z", "project-2"),
  run("c", "serp", "running", "2026-10-06T11:45:00.000Z", null, "project-2"),
];
const titles: Record<string, string> = { blog: "Blog draft", serp: "SERP check" };
const titleOf = (taskId: string) => titles[taskId] ?? taskId;
const ids = (list: ReadonlyArray<ScheduledTaskRun>) => list.map((entry) => entry.messageId);

describe("scheduled runs table", () => {
  it("shows newest runs first by default and filters by task, state, and project", () => {
    expect(ids(visibleRuns(runs, NO_RUN_FILTER, DEFAULT_RUN_SORT, titleOf, NOW))).toEqual([
      "c",
      "b",
      "a",
    ]);
    expect(
      ids(visibleRuns(runs, { ...NO_RUN_FILTER, taskId: "serp" }, DEFAULT_RUN_SORT, titleOf, NOW)),
    ).toEqual(["c", "b"]);
    expect(
      ids(visibleRuns(runs, { ...NO_RUN_FILTER, state: "failed" }, DEFAULT_RUN_SORT, titleOf, NOW)),
    ).toEqual(["b"]);
    expect(
      ids(
        visibleRuns(
          runs,
          { ...NO_RUN_FILTER, projectId: "project-1" },
          DEFAULT_RUN_SORT,
          titleOf,
          NOW,
        ),
      ),
    ).toEqual(["a"]);
  });

  it("sorts by duration including running time, by status with failures first, and by task", () => {
    const byDuration = toggleSort(DEFAULT_RUN_SORT, "duration");
    expect(byDuration).toEqual({ key: "duration", descending: true });
    // c has run 15 minutes so far, a took 10, b took 1.
    expect(ids(visibleRuns(runs, NO_RUN_FILTER, byDuration, titleOf, NOW))).toEqual([
      "c",
      "a",
      "b",
    ]);
    const byStatus = toggleSort(DEFAULT_RUN_SORT, "status");
    expect(ids(visibleRuns(runs, NO_RUN_FILTER, byStatus, titleOf, NOW))).toEqual(["b", "c", "a"]);
    const byTask = toggleSort(DEFAULT_RUN_SORT, "task");
    expect(ids(visibleRuns(runs, NO_RUN_FILTER, byTask, titleOf, NOW))).toEqual(["a", "c", "b"]);
    expect(toggleSort(byTask, "task")).toEqual({ key: "task", descending: true });
  });

  it("formats durations at a glance", () => {
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(5 * 60_000 + 3_000)).toBe("5m 3s");
    expect(formatDuration(2 * 3_600_000 + 7 * 60_000)).toBe("2h 7m");
  });
});
