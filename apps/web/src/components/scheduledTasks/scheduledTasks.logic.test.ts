import {
  MessageId,
  ProjectId,
  type ScheduledTask,
  type ScheduledTaskRun,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_RUN_SORT,
  DEFAULT_TASK_SORT,
  NO_RUN_FILTER,
  RUN_SORT_DESCENDING_FIRST,
  TASK_SORT_DESCENDING_FIRST,
  type TaskLabels,
  formatDuration,
  toggleSort,
  visibleRuns,
  visibleTasks,
} from "./scheduledTasks.logic";

const run = (
  id: string,
  title: string,
  state: ScheduledTaskRun["state"],
  startedAt: string,
  finishedAt: string | null,
): ScheduledTaskRun => ({
  messageId: MessageId.make(id),
  taskId: ScheduledTaskId.make("serp"),
  threadId: ThreadId.make(`chat-${id}`),
  projectId: ProjectId.make("project-1"),
  threadTitle: title,
  startedAt,
  finishedAt,
  state,
});

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const runs = [
  run("a", "SERP morning", "succeeded", "2026-10-06T06:00:00.000Z", "2026-10-06T06:10:00.000Z"),
  run("b", "SERP adaptive", "failed", "2026-10-06T09:15:00.000Z", "2026-10-06T09:16:00.000Z"),
  run("c", "Adaptive retry", "running", "2026-10-06T11:45:00.000Z", null),
];
const ids = (list: ReadonlyArray<{ readonly messageId: string }>) =>
  list.map((entry) => entry.messageId);

describe("a task's runs table", () => {
  it("shows newest runs first and narrows by status and by words in the chat title", () => {
    expect(ids(visibleRuns(runs, NO_RUN_FILTER, DEFAULT_RUN_SORT, NOW))).toEqual(["c", "b", "a"]);
    expect(
      ids(visibleRuns(runs, { ...NO_RUN_FILTER, state: "failed" }, DEFAULT_RUN_SORT, NOW)),
    ).toEqual(["b"]);
    expect(
      ids(visibleRuns(runs, { ...NO_RUN_FILTER, query: "adaptive" }, DEFAULT_RUN_SORT, NOW)),
    ).toEqual(["c", "b"]);
    expect(
      ids(visibleRuns(runs, { ...NO_RUN_FILTER, query: "serp ADAPT" }, DEFAULT_RUN_SORT, NOW)),
    ).toEqual(["b"]);
  });

  it("sorts by duration including running time, by status with failures first, and by chat", () => {
    const sortBy = (key: (typeof RUN_SORT_DESCENDING_FIRST)[number] | "chat" | "status") =>
      toggleSort(DEFAULT_RUN_SORT, key, RUN_SORT_DESCENDING_FIRST);
    // c has run 15 minutes so far, a took 10, b took 1.
    expect(ids(visibleRuns(runs, NO_RUN_FILTER, sortBy("duration"), NOW))).toEqual(["c", "a", "b"]);
    expect(ids(visibleRuns(runs, NO_RUN_FILTER, sortBy("status"), NOW))).toEqual(["b", "c", "a"]);
    const byChat = sortBy("chat");
    expect(ids(visibleRuns(runs, NO_RUN_FILTER, byChat, NOW))).toEqual(["c", "b", "a"]);
    expect(toggleSort(byChat, "chat", RUN_SORT_DESCENDING_FIRST)).toEqual({
      key: "chat",
      descending: true,
    });
  });

  it("formats durations at a glance", () => {
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(5 * 60_000 + 3_000)).toBe("5m 3s");
    expect(formatDuration(2 * 3_600_000 + 7 * 60_000)).toBe("2h 7m");
  });
});

const task = (
  id: string,
  title: string,
  fields: Partial<Pick<ScheduledTask, "enabled" | "lastRunAt" | "nextRunAt" | "runCount">> = {},
  projectId = "project-1",
) =>
  ({
    id: ScheduledTaskId.make(id),
    title,
    prompt: `Run ${title}`,
    enabled: true,
    projectId: ProjectId.make(projectId),
    lastRunAt: null,
    nextRunAt: null,
    runCount: 0,
    ...fields,
  }) as ScheduledTask;

const tasks = [
  task("serp", "SERP adaptive checks", {
    lastRunAt: "2026-10-06T11:45:00.000Z",
    nextRunAt: "2026-10-06T12:15:00.000Z",
    runCount: 30,
  }),
  task("blog", "Blog draft", { nextRunAt: "2026-10-07T06:00:00.000Z" }, "project-2"),
  task(
    "vendors",
    "Enrich vendors",
    { enabled: false, lastRunAt: "2026-10-05T03:00:00.000Z", runCount: 4 },
    "project-2",
  ),
];
const labels = (entry: ScheduledTask): TaskLabels => ({
  project: entry.projectId === "project-1" ? "SEO" : "Content",
  schedule: entry.id === "serp" ? "Cron 15,45 2-19 * * *" : "Daily at 06:00",
  folder: entry.id === "serp" ? "SERP/Adaptive" : "",
  model: "GPT-5.6-Sol",
});
const taskIds = (list: ReadonlyArray<ScheduledTask>) => list.map((entry) => entry.id);
const ALL_TASKS = { query: "", projectId: null };

describe("the scheduled task list", () => {
  it("narrows by project and by words in the title, prompt, project, schedule, or folder", () => {
    expect(taskIds(visibleTasks(tasks, ALL_TASKS, DEFAULT_TASK_SORT, labels))).toEqual([
      "blog",
      "vendors",
      "serp",
    ]);
    expect(
      taskIds(
        visibleTasks(tasks, { ...ALL_TASKS, projectId: "project-2" }, DEFAULT_TASK_SORT, labels),
      ),
    ).toEqual(["blog", "vendors"]);
    for (const query of ["adaptive", "seo", "15,45", "serp/adap"]) {
      expect(
        taskIds(visibleTasks(tasks, { ...ALL_TASKS, query }, DEFAULT_TASK_SORT, labels)),
      ).toEqual(["serp"]);
    }
    expect(
      taskIds(
        visibleTasks(tasks, { ...ALL_TASKS, query: "content run" }, DEFAULT_TASK_SORT, labels),
      ),
    ).toEqual(["blog", "vendors"]);
  });

  it("sorts by runs, last run, and next run with never-ran and paused tasks last", () => {
    const sortBy = (key: "runs" | "lastRun" | "nextRun") =>
      toggleSort(DEFAULT_TASK_SORT, key, TASK_SORT_DESCENDING_FIRST);
    expect(taskIds(visibleTasks(tasks, ALL_TASKS, sortBy("runs"), labels))).toEqual([
      "serp",
      "vendors",
      "blog",
    ]);
    const byLastRun = sortBy("lastRun");
    expect(taskIds(visibleTasks(tasks, ALL_TASKS, byLastRun, labels))).toEqual([
      "serp",
      "vendors",
      "blog",
    ]);
    const oldestFirst = toggleSort(byLastRun, "lastRun", TASK_SORT_DESCENDING_FIRST);
    expect(taskIds(visibleTasks(tasks, ALL_TASKS, oldestFirst, labels))).toEqual([
      "vendors",
      "serp",
      "blog",
    ]);
    expect(taskIds(visibleTasks(tasks, ALL_TASKS, sortBy("nextRun"), labels))).toEqual([
      "serp",
      "blog",
      "vendors",
    ]);
  });
});
