import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  type Automation,
  type AutomationCheckout,
  type AutomationStep,
  type AutomationTrigger,
  type EnvironmentId,
  type ModelSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useAutomationsDispatch } from "../../state/automations";
import { useBoards } from "../../state/boards";
import { useProjects } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { TraitsPicker } from "../chat/TraitsPicker";
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
  columnNamesAcrossBoards,
  DEFAULT_SCHEDULE_FORM,
  formToSchedule,
  type RepeatKind,
  type ScheduleForm,
  scheduleToForm,
  WEEKDAY_LABELS,
} from "./automations.logic";
import { type StepRow, StepsEditor, toStepRows } from "./StepsEditor";

/** Prefill for a new scheduled automation or workflow preset. */
export interface AutomationDraft {
  readonly title?: string;
  readonly prompt?: string;
  readonly repeat?: RepeatKind;
  readonly trigger?: "schedule" | "workflow";
  /** Built-in steps instead of a chat. */
  readonly steps?: ReadonlyArray<AutomationStep>;
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
  ticket: "The ticket's own worktrees",
  local: "The project folder (shared)",
  worktree: "A fresh worktree each run",
};

/** Select values that are not ids. */
const INHERIT_PROJECT = "__inherit__";

const WORKFLOW_PROMPT_HINT =
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
  hint,
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * The model and its traits (effort, fast mode) a run starts with; null keeps
 * the project's default model.
 */
function AutomationModelField({
  environmentId,
  value,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly value: ModelSelection | null;
  readonly onChange: (value: ModelSelection | null) => void;
}) {
  const { environments } = useEnvironments();
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.providers ?? EMPTY_SERVER_PROVIDERS;
  const selection =
    value ?? resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const activeEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);
  if (!selection) {
    return <p className="text-sm text-muted-foreground">No providers available</p>;
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <ProviderModelPicker
        activeInstanceId={selection.instanceId}
        model={selection.model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={modelOptions}
        {...(value === null ? { triggerLabel: "Project default" } : {})}
        triggerAriaLabel="Model"
        onInstanceModelChange={(instanceId, model) =>
          onChange(createModelSelection(instanceId, model))
        }
      />
      {value !== null && activeEntry ? (
        <TraitsPicker
          provider={activeEntry.driverKind}
          models={activeEntry.models}
          model={value.model}
          prompt=""
          onPromptChange={() => {}}
          modelOptions={value.options ?? []}
          allowPromptInjectedEffort={false}
          planModeEnabled={settings.planModeEnabled}
          onModelOptionsChange={(options) =>
            onChange(createModelSelection(value.instanceId, value.model, options))
          }
        />
      ) : null}
      {value !== null ? (
        <Button type="button" size="xs" variant="ghost" onClick={() => onChange(null)}>
          Use project default
        </Button>
      ) : null}
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
  const formId = useId();
  const dispatch = useAutomationsDispatch();
  const boards = useBoards();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const initialTrigger = automation?.trigger;
  const isWorkflow = initialTrigger?.type === "workflow" || draft?.trigger === "workflow";
  const kind = isWorkflow ? "workflow" : "schedule";

  const [title, setTitle] = useState(automation?.title ?? draft?.title ?? "");
  const [prompt, setPrompt] = useState(automation?.prompt ?? draft?.prompt ?? "");
  const initialSteps = automation?.action.steps ?? draft?.steps ?? [];
  const [does, setDoes] = useState<"chat" | "steps">(initialSteps.length > 0 ? "steps" : "chat");
  const [stepRows, setStepRows] = useState<StepRow[]>(() => toStepRows(initialSteps));
  const steps = stepRows.map((row) => row.step);
  const [schedule, setSchedule] = useState<ScheduleForm>(
    initialTrigger?.type === "schedule"
      ? scheduleToForm(initialTrigger.schedule)
      : { ...DEFAULT_SCHEDULE_FORM, ...(draft?.repeat ? { repeat: draft.repeat } : {}) },
  );
  const [timezone, setTimezone] = useState(
    initialTrigger?.type === "schedule" ? initialTrigger.timezone : browserTimezone(),
  );
  const [projectKey, setProjectKey] = useState<string | null>(
    automation?.action.projectKey ?? null,
  );
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(
    automation?.action.modelSelection ?? null,
  );
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(
    automation?.action.runtimeMode ?? "full-access",
  );
  // Workflow sessions share the ticket's workspace by default.
  const [checkout, setCheckout] = useState<AutomationCheckout>(
    automation?.action.checkout ?? (isWorkflow ? "ticket" : "local"),
  );
  const [enabled, setEnabled] = useState(automation?.enabled ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const liveBoards =
    boards.status === "ready"
      ? boards.snapshot.boards.filter((board) => board.archivedAt === null)
      : [];
  const columnNameOptions = columnNamesAcrossBoards(liveBoards);
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
    (isWorkflow ? "Inherit from the ticket, then the board" : "Choose a project");

  const updateSchedule = (patch: Partial<ScheduleForm>) =>
    setSchedule((current) => ({ ...current, ...patch }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    let trigger: AutomationTrigger;
    if (kind === "schedule") {
      const compiled = formToSchedule(schedule);
      if (!compiled.ok) return setError(compiled.message);
      if (does === "chat" && projectKey === null) {
        return setError("A scheduled automation needs a project.");
      }
      trigger = {
        type: "schedule",
        schedule: compiled.schedule,
        timezone: timezone.trim() || "UTC",
      };
    } else {
      trigger = { type: "workflow" };
    }
    if (!title.trim()) return setError("Give it a title.");
    if (does === "chat" && !prompt.trim())
      return setError("Write the prompt the chat starts with.");
    if (does === "steps" && steps.length === 0) return setError("Add at least one step.");
    const action = {
      projectKey,
      modelSelection,
      runtimeMode,
      interactionMode: automation?.action.interactionMode ?? ("default" as const),
      checkout,
      ...(does === "steps" ? { steps } : {}),
    };
    setSubmitting(true);
    const common = {
      title: title.trim(),
      prompt: does === "chat" ? prompt.trim() : "",
      trigger,
      action,
      enabled,
      maxRunsPerTicket: automation?.maxRunsPerTicket ?? 5,
    };
    const result = await dispatch(
      automation
        ? { type: "automation.update", automationId: automation.id, ...common }
        : { type: "automation.create", ...common },
    );
    setSubmitting(false);
    if (result !== undefined) onDone();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {isWorkflow
            ? automation
              ? "Edit workflow preset"
              : "New workflow preset"
            : automation
              ? "Edit automation"
              : "New automation"}
        </DialogTitle>
        <DialogDescription>
          {isWorkflow
            ? "Select this preset on a ticket, then Start or Resume. Tickets keep an editable copy of these instructions."
            : "Starts a chat or performs cleanup on a schedule."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form id={formId} className="space-y-4" onSubmit={(event) => void submit(event)}>
          <Field label="Title" htmlFor="automation-title">
            <Input
              id="automation-title"
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={isWorkflow ? "Feature workflow" : "Weekly dependency audit"}
            />
          </Field>
          {!isWorkflow ? (
            <Field label="Does">
              <ToggleGroup
                aria-label="What it does"
                variant="segmented"
                value={[does]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "chat" || value === "steps") setDoes(value);
                }}
              >
                <Toggle value="chat">Start a chat</Toggle>
                <Toggle value="steps">Run steps (no chat)</Toggle>
              </ToggleGroup>
            </Field>
          ) : null}
          {does === "steps" ? (
            <Field label="Steps">
              <StepsEditor
                trigger="schedule"
                rows={stepRows}
                onChange={setStepRows}
                columnNames={columnNameOptions}
                boardNameOf={(boardId) =>
                  liveBoards.find((board) => board.id === boardId)?.name ?? "a deleted board"
                }
              />
            </Field>
          ) : null}
          {does === "chat" ? (
            <Field
              label={isWorkflow ? "Instructions" : "Prompt"}
              htmlFor="automation-prompt"
              hint={isWorkflow ? WORKFLOW_PROMPT_HINT : undefined}
            >
              <Textarea
                id="automation-prompt"
                rows={5}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={
                  isWorkflow
                    ? "Test {{ticket.key}} and check off its acceptance criteria…"
                    : "Check for outdated dependencies and open a PR…"
                }
              />
            </Field>
          ) : null}

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
          ) : null}

          {does === "chat" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Project">
                <Select
                  value={projectKey ?? INHERIT_PROJECT}
                  onValueChange={(value) =>
                    setProjectKey(value === INHERIT_PROJECT || !value ? null : String(value))
                  }
                >
                  <SelectTrigger aria-label="Project">
                    <SelectValue>{projectLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {isWorkflow ? (
                      <SelectItem value={INHERIT_PROJECT}>
                        Inherit from the ticket, then the board
                      </SelectItem>
                    ) : null}
                    {projectOptions.map((option) => (
                      <SelectItem key={option.key} value={option.key}>
                        {option.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              <Field label="Model">
                {primaryEnvironmentId ? (
                  <AutomationModelField
                    environmentId={primaryEnvironmentId}
                    value={modelSelection}
                    onChange={setModelSelection}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">Not connected</p>
                )}
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
                    {(Object.keys(CHECKOUT_LABEL) as AutomationCheckout[])
                      // A schedule has no ticket to share a workspace with.
                      .filter((option) =>
                        isWorkflow ? option !== "worktree" : option !== "ticket",
                      )
                      .map((option) => (
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
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-muted-foreground">
              {does === "chat"
                ? "Full access runs do not stop to ask; pick Supervised to approve each command."
                : "Steps run instantly without a chat; the first that fails stops and flags the ticket."}
            </p>
            <label className="flex shrink-0 items-center gap-2 text-sm">
              <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />
              Enabled
            </label>
          </div>
          {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
        </form>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" form={formId} disabled={submitting}>
          {automation ? "Save" : isWorkflow ? "Create workflow" : "Create automation"}
        </Button>
      </DialogFooter>
    </>
  );
}
