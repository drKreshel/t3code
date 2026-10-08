/**
 * One scheduled task (fork): what it runs and where its runs are filed, with
 * every run to search, filter by status, and sort. Editing opens upstream's
 * editor.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScheduledTask,
  type ScheduledTaskRunState,
  ScheduledTaskRunState as ScheduledTaskRunStates,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { PauseIcon, PencilIcon, PlayIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

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
import { Table, TableBody, TableCell, TableHeader, TableRow } from "../ui/table";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useSetTaskFolder, useTaskFolders } from "../../state/taskFolders";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  DEFAULT_RUN_SORT,
  NO_RUN_FILTER,
  RUN_SORT_DESCENDING_FIRST,
  type RunFilter,
  type RunSortKey,
  type Sort,
  formatDuration,
  runDurationMs,
  toggleSort,
  visibleRuns,
} from "./scheduledTasks.logic";
import {
  FilterSelect,
  STATE_LABEL,
  SearchField,
  SortableHead,
  formatWhen,
  modelLabel,
  stateVariant,
} from "./scheduledTasksShared";

/** How often to re-read runs while one is still going; finished runs change nothing. */
const LIVE_RUNS_REFRESH_MS = 15_000;

export function ScheduledTaskPage({ taskId }: { readonly taskId: string }) {
  const environmentId = usePrimaryEnvironmentId();
  const tasksQuery = useEnvironmentQuery(
    environmentId ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
  );
  const task = tasksQuery.data?.tasks.find((candidate) => candidate.id === taskId) ?? null;
  const [editing, setEditing] = useState(false);

  return (
    <BoardsPageFrame
      root="Scheduled Tasks"
      crumbs={[{ label: task?.title ?? "Task" }]}
      actions={
        task && environmentId ? (
          <TaskActions environmentId={environmentId} task={task} onEdit={() => setEditing(true)} />
        ) : null
      }
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-6">
        {tasksQuery.error ? (
          <p className="text-sm text-destructive-foreground">
            Could not load scheduled tasks: {tasksQuery.error}
          </p>
        ) : !tasksQuery.data || !environmentId ? null : !task ? (
          <p className="text-sm text-muted-foreground">
            This task no longer exists.{" "}
            <Link to="/scheduled" className="underline">
              Back to Scheduled Tasks
            </Link>
          </p>
        ) : (
          <>
            <TaskDetails environmentId={environmentId} task={task} />
            <RunsSection
              environmentId={environmentId}
              task={task}
              tasksUpdatedAt={tasksQuery.dataUpdatedAt}
            />
          </>
        )}
      </div>
      {editing && task && environmentId ? (
        <SettingsScopeProvider search={{}} onChange={() => undefined}>
          <ScheduledTaskEditorDialog
            initialEnvironmentId={environmentId}
            task={task}
            onClose={() => setEditing(false)}
          />
        </SettingsScopeProvider>
      ) : null}
    </BoardsPageFrame>
  );
}

function TaskActions({
  environmentId,
  task,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly onEdit: () => void;
}) {
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const toggle = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "scheduled task enabled",
  });
  const run = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run now",
  });
  const act = async (action: "toggle" | "run") => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    setBusy(true);
    const result =
      action === "toggle"
        ? await toggle({ environmentId, input: { id: task.id, enabled: !task.enabled } })
        : await run({ environmentId, input: { id: task.id } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update scheduled task",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  return (
    <>
      {task.schedule.type === "webhook" ? null : (
        <Button
          size="xs"
          variant="ghost"
          disabled={busy || !canOperate}
          onClick={() => void act("run")}
        >
          <PlayIcon />
          Run now
        </Button>
      )}
      <Button
        size="xs"
        variant="ghost"
        disabled={busy || !canOperate}
        onClick={() => void act("toggle")}
      >
        {task.enabled ? <PauseIcon /> : <PlayIcon />}
        {task.enabled ? "Pause" : "Resume"}
      </Button>
      <Button size="xs" disabled={!canOperate} onClick={onEdit}>
        <PencilIcon />
        Edit
      </Button>
    </>
  );
}

function TaskDetails({
  environmentId,
  task,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
}) {
  const projects = useProjects();
  const folders = useTaskFolders();
  const project = projects.find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === task.projectId,
  );
  const folder =
    folders.status === "ready"
      ? (folders.routes.find((route) => route.taskId === task.id)?.folder ?? "")
      : "";
  return (
    <section className="flex flex-col gap-4">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <Detail label="Schedule">{scheduleLabel(task.schedule)}</Detail>
        <Detail label="Next run">
          {task.enabled ? relativeLabel(task.nextRunAt) : <Badge variant="outline">Paused</Badge>}
        </Detail>
        <Detail label="Last run">
          <span className="flex flex-wrap items-center gap-2">
            {task.lastRunAt ? formatWhen(task.lastRunAt) : null}
            <Badge variant={stateVariant(task.lastRunStatus)}>
              {STATE_LABEL[task.lastRunStatus]}
            </Badge>
            {task.lastRunError ? (
              <span className="text-destructive-foreground">{task.lastRunError}</span>
            ) : null}
          </span>
        </Detail>
        <Detail label="Project">{project?.title ?? task.projectId}</Detail>
        <Detail label="Model">{modelLabel(task.modelSelection)}</Detail>
        <Detail label="Put runs in folder">
          {/* Remount when the stored folder changes, so the field shows what stuck. */}
          <FolderField
            key={`${task.id}:${folder}`}
            taskId={task.id}
            folder={folder}
            disabled={folders.status !== "ready"}
          />
        </Detail>
      </dl>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Prompt</summary>
        <p className="mt-2 whitespace-pre-wrap rounded-md border border-border/60 p-3">
          {task.prompt}
        </p>
      </details>
    </section>
  );
}

function Detail({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
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
      placeholder="No folder, such as SERP/Adaptive checks"
      className="w-72"
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
  task,
  tasksUpdatedAt,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly tasksUpdatedAt: number;
}) {
  const runsQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTaskRuns({ environmentId, input: { id: task.id } }),
  );
  const runs = runsQuery.data?.runs ?? [];
  const [filter, setFilter] = useState<RunFilter>(NO_RUN_FILTER);
  const [sort, setSort] = useState<Sort<RunSortKey>>(DEFAULT_RUN_SORT);

  // Each run start updates the task; a finishing run does not, so poll only while one is live.
  const refreshRuns = runsQuery.refresh;
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

  const shown = visibleRuns(runs, filter, sort, nowMs);
  const onSort = (key: RunSortKey) =>
    setSort((current) => toggleSort(current, key, RUN_SORT_DESCENDING_FIRST));

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-2 text-sm font-medium">Runs</h2>
        <SearchField
          value={filter.query}
          placeholder="Search runs"
          onChange={(query) => setFilter((current) => ({ ...current, query }))}
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
        <span className="ml-auto text-xs text-muted-foreground">
          {shown.length === runs.length
            ? `${runs.length} ${runs.length === 1 ? "run" : "runs"}`
            : `${shown.length} of ${runs.length} runs`}
        </span>
      </div>
      {runsQuery.error ? (
        <p className="text-sm text-destructive-foreground">
          Could not load runs: {runsQuery.error}
        </p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {runs.length === 0 ? "No runs yet." : "No runs match these filters."}
        </p>
      ) : (
        <Table aria-label={`Runs of ${task.title}`}>
          <TableHeader>
            <TableRow>
              <SortableHead sortKey="chat" sort={sort} onSort={onSort}>
                Chat
              </SortableHead>
              <SortableHead sortKey="started" sort={sort} onSort={onSort}>
                Started
              </SortableHead>
              <SortableHead sortKey="duration" sort={sort} onSort={onSort}>
                Duration
              </SortableHead>
              <SortableHead sortKey="status" sort={sort} onSort={onSort}>
                Status
              </SortableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((run) => (
              <TableRow key={run.messageId}>
                <TableCell>
                  <Link
                    to="/$environmentId/$threadId"
                    params={{ environmentId, threadId: run.threadId }}
                    className="block max-w-96 truncate hover:underline"
                  >
                    {run.threadTitle || "Untitled chat"}
                  </Link>
                </TableCell>
                <TableCell>
                  <span className="text-muted-foreground">{formatWhen(run.startedAt)}</span>
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
