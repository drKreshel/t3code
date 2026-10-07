/**
 * Scheduled Tasks (fork): every task with where its runs are filed, and a
 * table of recent runs to filter and sort. Creating and editing open
 * upstream's editor, so Settings → Scheduled Tasks stays the same.
 */
import {
  type EnvironmentId,
  type ScheduledTask,
  type ScheduledTaskRun,
  type ScheduledTaskRunState,
  ScheduledTaskRunState as ScheduledTaskRunStates,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { BoardsPageFrame } from "../boards/BoardsPageFrame";
import {
  ScheduledTaskEditorDialog,
  relativeLabel,
  scheduleLabel,
} from "../settings/ScheduledTasksSettings";
import { SettingsScopeProvider } from "../settings/SettingsScopeContext";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useSetTaskFolder, useTaskFolders } from "../../state/taskFolders";
import {
  DEFAULT_RUN_SORT,
  NO_RUN_FILTER,
  type RunFilter,
  type RunSort,
  type RunSortKey,
  formatDuration,
  runDurationMs,
  toggleSort,
  visibleRuns,
} from "./scheduledRuns.logic";

const ALL = "all";
/** How often to re-read runs while one is still going; finished runs change nothing. */
const LIVE_RUNS_REFRESH_MS = 15_000;

const STATE_LABEL: Record<ScheduledTaskRunState, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  stopped: "Stopped",
};

function stateVariant(state: ScheduledTaskRunState) {
  if (state === "failed") return "error";
  if (state === "succeeded") return "success";
  if (state === "running") return "info";
  return "outline";
}

const formatStarted = (value: string) =>
  new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export function ScheduledTasksPage() {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const tasksQuery = useEnvironmentQuery(
    environmentId ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
  );
  const runsQuery = useEnvironmentQuery(
    environmentId ? serverEnvironment.scheduledTaskRuns({ environmentId, input: {} }) : null,
  );
  const tasks = tasksQuery.data?.tasks ?? [];
  const runs = runsQuery.data?.runs ?? [];
  const [editor, setEditor] = useState<{ readonly task: ScheduledTask | null } | null>(null);

  // Each run start updates the task list; a finishing run does not, so poll only while one is live.
  const refreshRuns = runsQuery.refresh;
  const tasksUpdatedAt = tasksQuery.dataUpdatedAt;
  useEffect(() => {
    if (tasksUpdatedAt > 0) refreshRuns();
  }, [refreshRuns, tasksUpdatedAt]);
  // Running runs' durations count up to the last refresh, not to every render.
  const nowMs = runsQuery.dataUpdatedAt;
  const live = runs.some((run) => run.state === "running" || run.state === "queued");
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(refreshRuns, LIVE_RUNS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, refreshRuns]);

  return (
    <BoardsPageFrame
      root="Scheduled Tasks"
      crumbs={[]}
      actions={
        <>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void navigate({ to: "/settings/scheduled-tasks" })}
          >
            <SettingsIcon />
            Settings
          </Button>
          <Button
            size="xs"
            disabled={environmentId === null}
            onClick={() => setEditor({ task: null })}
          >
            <PlusIcon />
            New task
          </Button>
        </>
      }
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-6">
        <TasksSection tasks={tasks} onEdit={(task) => setEditor({ task })} />
        {environmentId ? (
          <RunsSection environmentId={environmentId} tasks={tasks} runs={runs} nowMs={nowMs} />
        ) : null}
        {runsQuery.error ? (
          <p className="text-sm text-destructive-foreground">
            Could not load runs: {runsQuery.error}
          </p>
        ) : null}
      </div>
      {editor && environmentId ? (
        <SettingsScopeProvider search={{}} onChange={() => undefined}>
          <ScheduledTaskEditorDialog
            key={editor.task?.id ?? "new"}
            initialEnvironmentId={environmentId}
            task={editor.task}
            onClose={() => setEditor(null)}
          />
        </SettingsScopeProvider>
      ) : null}
    </BoardsPageFrame>
  );
}

function TasksSection({
  tasks,
  onEdit,
}: {
  readonly tasks: ReadonlyArray<ScheduledTask>;
  readonly onEdit: (task: ScheduledTask) => void;
}) {
  const folders = useTaskFolders();
  const folderOf = (taskId: string) =>
    folders.status === "ready"
      ? (folders.routes.find((route) => route.taskId === taskId)?.folder ?? "")
      : "";
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">Tasks</h2>
      {tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No scheduled tasks yet. Create one with New task, or ask an agent to schedule work.
        </p>
      ) : (
        <Table aria-label="Scheduled tasks">
          <TableHeader>
            <TableRow>
              <TableHead>Task</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>Next run</TableHead>
              <TableHead>Put runs in folder</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.map((task) => (
              <TableRow key={task.id}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <span className="truncate">{task.title}</span>
                    {task.enabled ? null : <Badge variant="outline">Paused</Badge>}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="text-muted-foreground">{scheduleLabel(task.schedule)}</span>
                </TableCell>
                <TableCell>
                  <span className="text-muted-foreground">
                    {task.enabled ? relativeLabel(task.nextRunAt) : "Paused"}
                  </span>
                </TableCell>
                <TableCell>
                  {/* Remount when the stored folder changes, so the field shows what stuck. */}
                  <FolderField
                    key={`${task.id}:${folderOf(task.id)}`}
                    taskId={task.id}
                    folder={folderOf(task.id)}
                    disabled={folders.status !== "ready"}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <Button size="xs" variant="ghost" onClick={() => onEdit(task)}>
                    Edit
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

const FOLDER_PATH = /^(?=[^/]*[^\s/])[^/]+(?:\/(?=[^/]*[^\s/])[^/]+)*$/;

/** Saves on Enter or blur; empty stops filing. Chats already filed stay put. */
function FolderField({
  taskId,
  folder,
  disabled,
}: {
  readonly taskId: ScheduledTask["id"];
  readonly folder: string;
  readonly disabled: boolean;
}) {
  const setFolder = useSetTaskFolder();
  const [value, setValue] = useState(folder);
  const save = () => {
    const trimmed = value
      .split("/")
      .map((name) => name.trim())
      .join("/");
    if (trimmed === folder) return;
    if (trimmed !== "" && !FOLDER_PATH.test(trimmed)) {
      setValue(folder);
      return;
    }
    void setFolder({ taskId, folder: trimmed === "" ? null : trimmed }).then((saved) => {
      if (!saved) setValue(folder);
    });
  };
  return (
    <Input
      size="compact"
      aria-label="Folder for this task's runs"
      placeholder="No folder"
      className="w-56"
      value={value}
      disabled={disabled}
      onChange={(event) => setValue(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

function RunsSection({
  environmentId,
  tasks,
  runs,
  nowMs,
}: {
  readonly environmentId: EnvironmentId;
  readonly tasks: ReadonlyArray<ScheduledTask>;
  readonly runs: ReadonlyArray<ScheduledTaskRun>;
  readonly nowMs: number;
}) {
  const projects = useProjects();
  const [filter, setFilter] = useState<RunFilter>(NO_RUN_FILTER);
  const [sort, setSort] = useState<RunSort>(DEFAULT_RUN_SORT);
  const taskTitle = useMemo(() => {
    const titles = new Map(tasks.map((task) => [task.id as string, task.title]));
    return (taskId: string) => titles.get(taskId) ?? "Deleted task";
  }, [tasks]);
  const projectTitle = (projectId: string) =>
    projects.find((project) => project.environmentId === environmentId && project.id === projectId)
      ?.title ?? projectId;
  const projectIds = [...new Set(runs.map((run) => run.projectId as string))];
  const taskIds = [...new Set(runs.map((run) => run.taskId as string))];
  const shown = visibleRuns(runs, filter, sort, taskTitle, nowMs);

  const header = (key: RunSortKey, label: string) => (
    <TableHead>
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={() => setSort((current) => toggleSort(current, key))}
      >
        {label}
        {sort.key === key ? (
          sort.descending ? (
            <ArrowDownIcon className="size-3" />
          ) : (
            <ArrowUpIcon className="size-3" />
          )
        ) : null}
      </button>
    </TableHead>
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Runs</h2>
        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect
            label="Task"
            value={filter.taskId}
            options={taskIds.map((id) => ({ value: id, label: taskTitle(id) }))}
            onChange={(taskId) => setFilter((current) => ({ ...current, taskId }))}
          />
          <FilterSelect
            label="Status"
            value={filter.state}
            options={ScheduledTaskRunStates.literals.map((state) => ({
              value: state,
              label: STATE_LABEL[state],
            }))}
            onChange={(state) =>
              setFilter((current) => ({ ...current, state: state as ScheduledTaskRunState | null }))
            }
          />
          {projectIds.length > 1 ? (
            <FilterSelect
              label="Project"
              value={filter.projectId}
              options={projectIds.map((id) => ({ value: id, label: projectTitle(id) }))}
              onChange={(projectId) => setFilter((current) => ({ ...current, projectId }))}
            />
          ) : null}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {runs.length === 0 ? "No runs yet." : "No runs match these filters."}
        </p>
      ) : (
        <Table aria-label="Scheduled task runs">
          <TableHeader>
            <TableRow>
              {header("task", "Task")}
              <TableHead>Chat</TableHead>
              {header("started", "Started")}
              {header("duration", "Duration")}
              {header("status", "Status")}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((run) => (
              <TableRow key={run.messageId}>
                <TableCell>
                  <span className="block max-w-56 truncate">{taskTitle(run.taskId)}</span>
                </TableCell>
                <TableCell>
                  <Link
                    to="/$environmentId/$threadId"
                    params={{ environmentId, threadId: run.threadId }}
                    className="block max-w-80 truncate hover:underline"
                  >
                    {run.threadTitle || "Untitled chat"}
                  </Link>
                </TableCell>
                <TableCell title={run.startedAt}>
                  <span className="text-muted-foreground">{formatStarted(run.startedAt)}</span>
                </TableCell>
                <TableCell>
                  <span className="text-muted-foreground">
                    {formatDuration(runDurationMs(run, nowMs))}
                  </span>
                </TableCell>
                <TableCell>
                  <Badge variant={stateVariant(run.state)}>{STATE_LABEL[run.state]}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly onChange: (value: string | null) => void;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <Select
      value={value ?? ALL}
      onValueChange={(next) => onChange(next === ALL || next === null ? null : String(next))}
    >
      <SelectTrigger
        size="sm"
        className="w-44"
        aria-label={`Filter runs by ${label.toLowerCase()}`}
      >
        <SelectValue>{selected ? `${label}: ${selected.label}` : `${label}: All`}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem value={ALL}>All</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
