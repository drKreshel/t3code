import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  Automation,
  AutomationCheckout,
  AutomationTrigger,
  RuntimeMode,
} from "@t3tools/contracts";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";

import { useAutomationsDispatch } from "../../state/automations";
import { useBoards } from "../../state/boards";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  DEFAULT_SCHEDULE_FORM,
  formToSchedule,
  type RepeatKind,
  type ScheduleForm,
  scheduleToForm,
  WEEKDAY_LABELS,
} from "./automations.logic";

/** Prefill for a new automation: a template, or a board hook from a board. */
export interface AutomationDraft {
  readonly title?: string;
  readonly prompt?: string;
  readonly repeat?: RepeatKind;
  readonly boardId?: string;
  readonly columnId?: string;
}

const REPEAT_LABEL: Record<RepeatKind, string> = {
  once: "Once",
  hourly: "Every hour",
  daily: "Every day",
  weekdays: "Weekdays",
  weekly: "Weekly",
  monthly: "Monthly",
  custom: "Custom (cron)",
};
const REPEATS = Object.keys(REPEAT_LABEL) as RepeatKind[];

const CHECKOUT_LABEL: Record<AutomationCheckout, string> = {
  local: "Project checkout",
  worktree: "New worktree per run",
};

const HOOK_PROMPT_HINT =
  "Variables: {{ticket.key}}, {{ticket.title}}, {{ticket.description}}, {{ticket.criteria}}, {{ticket.handoff}}, {{board.name}}, {{run.number}}.";

const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Creates or edits an automation: what to say, when, and how the chat runs. */
export function AutomationDialog({
  open,
  onOpenChange,
  automation,
  draft,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Edits this automation; omitted for a new one. */
  readonly automation?: Automation | null;
  readonly draft?: AutomationDraft | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        {/* Remount per open so fields start from the automation being edited. */}
        {open ? (
          <AutomationForm
            automation={automation ?? null}
            draft={draft ?? null}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

function AutomationForm({
  automation,
  draft,
  onDone,
}: {
  readonly automation: Automation | null;
  readonly draft: AutomationDraft | null;
  readonly onDone: () => void;
}) {
  const dispatch = useAutomationsDispatch();
  const boards = useBoards();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const initialTrigger = automation?.trigger;

  const [title, setTitle] = useState(automation?.title ?? draft?.title ?? "");
  const [prompt, setPrompt] = useState(automation?.prompt ?? draft?.prompt ?? "");
  const [kind, setKind] = useState<AutomationTrigger["type"]>(
    initialTrigger?.type ?? (draft?.boardId ? "board" : "schedule"),
  );
  const [schedule, setSchedule] = useState<ScheduleForm>(
    initialTrigger?.type === "schedule"
      ? scheduleToForm(initialTrigger.schedule)
      : { ...DEFAULT_SCHEDULE_FORM, ...(draft?.repeat ? { repeat: draft.repeat } : {}) },
  );
  const [timezone, setTimezone] = useState(
    initialTrigger?.type === "schedule" ? initialTrigger.timezone : browserTimezone(),
  );
  const [boardId, setBoardId] = useState(
    initialTrigger?.type === "board" ? initialTrigger.boardId : (draft?.boardId ?? ""),
  );
  const [columnId, setColumnId] = useState(
    initialTrigger?.type === "board" ? initialTrigger.columnId : (draft?.columnId ?? ""),
  );
  const [maxRuns, setMaxRuns] = useState(automation?.maxRunsPerTicket ?? 3);
  const [projectKey, setProjectKey] = useState<string | null>(
    automation?.action.projectKey ?? null,
  );
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(
    automation?.action.runtimeMode ?? "full-access",
  );
  const [checkout, setCheckout] = useState<AutomationCheckout>(
    automation?.action.checkout ?? "local",
  );
  const [enabled, setEnabled] = useState(automation?.enabled ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const liveBoards =
    boards.status === "ready"
      ? boards.snapshot.boards.filter((board) => board.archivedAt === null)
      : [];
  const board = liveBoards.find((candidate) => candidate.id === boardId);
  const columns = board?.columns.toSorted((a, b) => a.position - b.position) ?? [];
  const projectOptions = useMemo(
    () =>
      projects
        .filter((project) => project.environmentId === primaryEnvironmentId)
        .map((project) => ({
          key: scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          title: project.title,
        }))
        .toSorted((a, b) => a.title.localeCompare(b.title)),
    [primaryEnvironmentId, projects],
  );
  const projectLabel =
    projectOptions.find((option) => option.key === projectKey)?.title ??
    (kind === "board" ? "Ticket's project, then the board's" : "Choose a project");

  const updateSchedule = (patch: Partial<ScheduleForm>) =>
    setSchedule((current) => ({ ...current, ...patch }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    let trigger: AutomationTrigger;
    if (kind === "schedule") {
      const compiled = formToSchedule(schedule);
      if (!compiled.ok) return setError(compiled.message);
      if (projectKey === null) return setError("A scheduled automation needs a project.");
      trigger = {
        type: "schedule",
        schedule: compiled.schedule,
        timezone: timezone.trim() || "UTC",
      };
    } else {
      if (!boardId || !columnId) return setError("Pick the board and the column.");
      trigger = { type: "board", boardId, columnId };
    }
    if (!title.trim() || !prompt.trim()) return setError("Give it a title and a prompt.");
    const action = {
      projectKey,
      modelSelection: automation?.action.modelSelection ?? null,
      runtimeMode,
      interactionMode: automation?.action.interactionMode ?? ("default" as const),
      checkout,
    };
    setSubmitting(true);
    const result = await dispatch(
      automation
        ? {
            type: "automation.update",
            automationId: automation.id,
            title: title.trim(),
            prompt: prompt.trim(),
            trigger,
            action,
            enabled,
            maxRunsPerTicket: Math.max(1, maxRuns),
          }
        : {
            type: "automation.create",
            title: title.trim(),
            prompt: prompt.trim(),
            trigger,
            action,
            enabled,
            maxRunsPerTicket: Math.max(1, maxRuns),
          },
    );
    setSubmitting(false);
    if (result !== undefined) onDone();
  };

  return (
    <form onSubmit={(event) => void submit(event)}>
      <DialogHeader>
        <DialogTitle>{automation ? "Edit automation" : "New automation"}</DialogTitle>
        <DialogDescription>
          Starts a new chat with your prompt on a schedule, or when a ticket enters a column.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <Field label="Title" htmlFor="automation-title">
          <Input
            id="automation-title"
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Weekly dependency audit"
          />
        </Field>
        <Field label="Prompt" htmlFor="automation-prompt">
          <Textarea
            id="automation-prompt"
            rows={5}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={
              kind === "board"
                ? "Test {{ticket.key}} and check off its acceptance criteria…"
                : "Check for outdated dependencies and open a PR…"
            }
          />
          {kind === "board" ? (
            <p className="text-xs text-muted-foreground">{HOOK_PROMPT_HINT}</p>
          ) : null}
        </Field>

        <Field label="Runs">
          <ToggleGroup
            aria-label="Trigger"
            variant="segmented"
            value={[kind]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "schedule" || value === "board") setKind(value);
            }}
          >
            <Toggle value="schedule">On a schedule</Toggle>
            <Toggle value="board">When a ticket enters a column</Toggle>
          </ToggleGroup>
        </Field>

        {kind === "schedule" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Repeat">
              <Select
                value={schedule.repeat}
                onValueChange={(value) => updateSchedule({ repeat: value as RepeatKind })}
              >
                <SelectTrigger aria-label="Repeat">
                  <SelectValue>{REPEAT_LABEL[schedule.repeat]}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {REPEATS.map((repeat) => (
                    <SelectItem key={repeat} value={repeat}>
                      {REPEAT_LABEL[repeat]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            {schedule.repeat === "once" ? (
              <Field label="At" htmlFor="automation-once">
                <Input
                  id="automation-once"
                  type="datetime-local"
                  value={schedule.onceAt}
                  onChange={(event) => updateSchedule({ onceAt: event.target.value })}
                />
              </Field>
            ) : schedule.repeat === "hourly" ? (
              <Field label="Minute past the hour" htmlFor="automation-minute">
                <Input
                  id="automation-minute"
                  type="number"
                  min={0}
                  max={59}
                  value={schedule.minute}
                  onChange={(event) =>
                    updateSchedule({
                      minute: Math.min(59, Math.max(0, Number(event.target.value))),
                    })
                  }
                />
              </Field>
            ) : schedule.repeat === "custom" ? (
              <Field label="Cron" htmlFor="automation-cron">
                <Input
                  id="automation-cron"
                  value={schedule.cron}
                  onChange={(event) => updateSchedule({ cron: event.target.value })}
                  placeholder="0 9 * * 1-5"
                />
              </Field>
            ) : (
              <Field label="At" htmlFor="automation-time">
                <Input
                  id="automation-time"
                  type="time"
                  value={schedule.time}
                  onChange={(event) => updateSchedule({ time: event.target.value })}
                />
              </Field>
            )}
            {schedule.repeat === "weekly" ? (
              <div className="sm:col-span-2">
                <Field label="On">
                  <ToggleGroup
                    aria-label="Days"
                    variant="segmented"
                    multiple
                    value={schedule.days.map(String)}
                    onValueChange={(next) => updateSchedule({ days: next.map(Number) })}
                  >
                    {WEEKDAY_LABELS.map((label, day) => (
                      <Toggle key={label} value={String(day)}>
                        {label}
                      </Toggle>
                    ))}
                  </ToggleGroup>
                </Field>
              </div>
            ) : null}
            {schedule.repeat === "monthly" ? (
              <Field label="Day of the month" htmlFor="automation-day">
                <Input
                  id="automation-day"
                  type="number"
                  min={1}
                  max={31}
                  value={schedule.dayOfMonth}
                  onChange={(event) =>
                    updateSchedule({
                      dayOfMonth: Math.min(31, Math.max(1, Number(event.target.value))),
                    })
                  }
                />
              </Field>
            ) : null}
            {schedule.repeat !== "once" ? (
              <Field label="Time zone" htmlFor="automation-timezone">
                <Input
                  id="automation-timezone"
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                  placeholder="Europe/Berlin"
                />
              </Field>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Board">
              <Select
                value={boardId}
                onValueChange={(value) => {
                  setBoardId(String(value));
                  setColumnId("");
                }}
              >
                <SelectTrigger aria-label="Board">
                  <SelectValue>{board?.name ?? "Choose a board"}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {liveBoards.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <Field label="Column">
              <Select
                value={columnId}
                disabled={!board}
                onValueChange={(value) => setColumnId(String(value))}
              >
                <SelectTrigger aria-label="Column">
                  <SelectValue>
                    {columns.find((column) => column.id === columnId)?.name ?? "Choose a column"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {columns.map((column) => (
                    <SelectItem key={column.id} value={column.id}>
                      {column.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <Field
              label="Runs per ticket before it goes to Needs you"
              htmlFor="automation-max-runs"
            >
              <Input
                id="automation-max-runs"
                type="number"
                min={1}
                max={20}
                value={maxRuns}
                onChange={(event) => setMaxRuns(Math.max(1, Number(event.target.value)))}
              />
            </Field>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Project">
            <Select
              value={projectKey ?? ""}
              onValueChange={(value) => setProjectKey(value ? String(value) : null)}
            >
              <SelectTrigger aria-label="Project">
                <SelectValue>{projectLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {kind === "board" ? (
                  <SelectItem value="">Ticket's project, then the board's</SelectItem>
                ) : null}
                {projectOptions.map((option) => (
                  <SelectItem key={option.key} value={option.key}>
                    {option.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <Field label="Checkout">
            <Select
              value={checkout}
              onValueChange={(value) => setCheckout(value as AutomationCheckout)}
            >
              <SelectTrigger aria-label="Checkout">
                <SelectValue>{CHECKOUT_LABEL[checkout]}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {(Object.keys(CHECKOUT_LABEL) as AutomationCheckout[]).map((option) => (
                  <SelectItem key={option} value={option}>
                    {CHECKOUT_LABEL[option]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <Field label="Access">
            <Select
              value={runtimeMode}
              onValueChange={(value) => setRuntimeMode(value as RuntimeMode)}
            >
              <SelectTrigger aria-label="Access">
                <SelectValue>{runtimeModeConfig[runtimeMode].label}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {runtimeModeOptions.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {runtimeModeConfig[mode].label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <Field label="Enabled">
            <div className="flex h-9 items-center sm:h-8">
              <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />
            </div>
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">
          Chats use the project's default model. Runs with Full access do not stop to ask; pick
          Supervised to approve each command.
        </p>
        {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {automation ? "Save" : "Create automation"}
        </Button>
      </DialogFooter>
    </form>
  );
}
