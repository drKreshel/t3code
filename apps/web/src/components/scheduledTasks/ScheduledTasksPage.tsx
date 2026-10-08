/**
 * Scheduled Tasks (fork): every task to search, filter by project, and sort.
 * A row opens the task's own page with its runs. Creating opens upstream's
 * editor, so Settings → Scheduled Tasks stays the same.
 */
import type { ScheduledTask } from "@t3tools/contracts";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { PlusIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";

import { BoardsPageFrame } from "../boards/BoardsPageFrame";
import {
  ScheduledTaskEditorDialog,
  relativeLabel,
  scheduleLabel,
} from "../settings/ScheduledTasksSettings";
import { SettingsScopeProvider } from "../settings/SettingsScopeContext";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useTaskFolders } from "../../state/taskFolders";
import {
  DEFAULT_TASK_SORT,
  type Sort,
  TASK_SORT_DESCENDING_FIRST,
  type TaskLabels,
  type TaskSortKey,
  toggleSort,
  visibleTasks,
} from "./scheduledTasks.logic";
import {
  FilterSelect,
  STATE_LABEL,
  SearchField,
  SortableHead,
  formatWhen,
  ModelText,
  ProjectIcon,
  formatModelLabel,
  useModelLabel,
  stateVariant,
} from "./scheduledTasksShared";

export interface ScheduledTasksSearch {
  readonly q?: string;
  readonly project?: string;
}

export function ScheduledTasksPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: "/scheduled/" });
  const environmentId = usePrimaryEnvironmentId();
  const tasksQuery = useEnvironmentQuery(
    environmentId ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
  );
  const tasks = tasksQuery.data?.tasks ?? [];
  const projects = useProjects();
  const folders = useTaskFolders();
  const [creating, setCreating] = useState(false);
  const [sort, setSort] = useState<Sort<TaskSortKey>>(DEFAULT_TASK_SORT);
  const modelLabel = useModelLabel(environmentId);

  const projectOf = (projectId: string) =>
    projects.find((project) => project.environmentId === environmentId && project.id === projectId);
  const projectTitle = (projectId: string) => projectOf(projectId)?.title ?? projectId;
  const folderOf = (taskId: string) =>
    folders.status === "ready"
      ? (folders.routes.find((route) => route.taskId === taskId)?.folder ?? "")
      : "";
  const labels = (task: ScheduledTask): TaskLabels => ({
    project: projectTitle(task.projectId),
    schedule: scheduleLabel(task.schedule),
    folder: folderOf(task.id),
    model: formatModelLabel(modelLabel(task.modelSelection)),
  });
  const projectId = search.project ?? null;
  const shown = visibleTasks(tasks, { query: search.q ?? "", projectId }, sort, labels);
  const projectOptions = [...new Set(tasks.map((task) => task.projectId as string))]
    .map((id) => ({ value: id, label: projectTitle(id) }))
    .toSorted((a, b) => a.label.localeCompare(b.label));

  const setSearch = (next: ScheduledTasksSearch) => {
    const merged = { ...search, ...next };
    void navigate({
      to: "/scheduled",
      search: {
        ...(merged.q ? { q: merged.q } : {}),
        ...(merged.project ? { project: merged.project } : {}),
      },
      replace: true,
    });
  };
  const onSort = (key: TaskSortKey) =>
    setSort((current) => toggleSort(current, key, TASK_SORT_DESCENDING_FIRST));
  const open = (task: ScheduledTask) =>
    void navigate({ to: "/scheduled/$taskId", params: { taskId: task.id } });

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
          <Button size="xs" disabled={environmentId === null} onClick={() => setCreating(true)}>
            <PlusIcon />
            New task
          </Button>
        </>
      }
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-6 py-6">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            value={search.q ?? ""}
            placeholder="Search tasks"
            onChange={(q) => setSearch({ q })}
          />
          <FilterSelect
            label="Project"
            value={projectId}
            options={projectOptions}
            onChange={(project) => setSearch({ project: project ?? "" })}
          />
          <span className="ml-auto text-xs text-muted-foreground">
            {shown.length === tasks.length
              ? `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`
              : `${shown.length} of ${tasks.length} tasks`}
          </span>
        </div>
        {tasksQuery.error ? (
          <p className="text-sm text-destructive-foreground">
            Could not load scheduled tasks: {tasksQuery.error}
          </p>
        ) : tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No scheduled tasks yet. Create one with New task, or ask an agent to schedule work.
          </p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tasks match this search.</p>
        ) : (
          <Table aria-label="Scheduled tasks">
            <TableHeader>
              <TableRow>
                <SortableHead sortKey="title" sort={sort} onSort={onSort}>
                  Task
                </SortableHead>
                <SortableHead sortKey="project" sort={sort} onSort={onSort}>
                  Project
                </SortableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Model</TableHead>
                <SortableHead sortKey="lastRun" sort={sort} onSort={onSort}>
                  Last run
                </SortableHead>
                <SortableHead sortKey="nextRun" sort={sort} onSort={onSort}>
                  Next run
                </SortableHead>
                <SortableHead sortKey="runs" sort={sort} onSort={onSort}>
                  Runs
                </SortableHead>
                <TableHead>Folder</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((task) => (
                <TableRow
                  key={task.id}
                  className="cursor-pointer"
                  onClick={(event) => {
                    // The title is a real link for keyboards and new tabs; let it navigate itself.
                    if (!(event.target as HTMLElement).closest("a")) open(task);
                  }}
                >
                  <TableCell>
                    <span className="flex max-w-72 items-center gap-2">
                      <Link
                        to="/scheduled/$taskId"
                        params={{ taskId: task.id }}
                        className="truncate font-medium hover:underline"
                      >
                        {task.title}
                      </Link>
                      {task.enabled ? null : <Badge variant="outline">Paused</Badge>}
                    </span>
                  </TableCell>
                  <TableCell>
                    <ProjectIcon
                      project={projectOf(task.projectId)}
                      fallbackTitle={task.projectId}
                    />
                  </TableCell>
                  <TableCell>
                    <span className="block max-w-64 whitespace-normal text-muted-foreground">
                      {scheduleLabel(task.schedule)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <ModelText label={modelLabel(task.modelSelection)} />
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      {task.lastRunAt ? (
                        <span className="text-muted-foreground">{formatWhen(task.lastRunAt)}</span>
                      ) : null}
                      <Badge variant={stateVariant(task.lastRunStatus)}>
                        {STATE_LABEL[task.lastRunStatus]}
                      </Badge>
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-muted-foreground">
                      {task.enabled ? relativeLabel(task.nextRunAt) : "Paused"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-muted-foreground tabular-nums">{task.runCount}</span>
                  </TableCell>
                  <TableCell>
                    <span className="block max-w-48 truncate text-muted-foreground">
                      {folderOf(task.id) || "—"}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      {creating && environmentId ? (
        <SettingsScopeProvider search={{}} onChange={() => undefined}>
          <ScheduledTaskEditorDialog
            initialEnvironmentId={environmentId}
            task={null}
            onClose={() => setCreating(false)}
          />
        </SettingsScopeProvider>
      ) : null}
    </BoardsPageFrame>
  );
}
