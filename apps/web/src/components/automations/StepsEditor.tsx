import type { AutomationStep, TicketStatus } from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

type StepType = AutomationStep["type"];

/** A step with a key for its row; steps themselves carry no ids. */
export interface StepRow {
  readonly id: number;
  readonly step: AutomationStep;
}

let nextRowId = 0;
/** Rows for steps loaded from an automation or a template. */
export function toStepRows(steps: ReadonlyArray<AutomationStep>): StepRow[] {
  return steps.map((step) => ({ id: nextRowId++, step }));
}

const STEP_LABEL: Record<StepType, string> = {
  setStatus: "Mark ticket as",
  moveTo: "Move to column",
  removeWorkspace: "Clean up worktrees",
  moveStale: "Move old tickets",
};

const STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Open (reopen)",
  done: "Done",
  canceled: "Canceled",
};

/** Ticket steps act on the ticket a board hook fired for; schedules sweep boards. */
const STEPS_FOR: Record<"board" | "schedule", ReadonlyArray<StepType>> = {
  board: ["setStatus", "moveTo", "removeWorkspace"],
  schedule: ["moveStale"],
};

function newStep(type: StepType, columnNames: ReadonlyArray<string>): AutomationStep {
  switch (type) {
    case "setStatus":
      return { type, status: "done" };
    case "moveTo":
      return { type, column: columnNames[0] ?? "Done" };
    case "removeWorkspace":
      return { type };
    case "moveStale":
      return { type, from: "Done", to: "Settled", olderThanDays: 7 };
  }
}

/**
 * Built-in steps an automation runs instead of a chat, in order. They apply
 * instantly and cost no tokens; the first that fails stops the rest and flags
 * the ticket.
 */
export function StepsEditor({
  trigger,
  rows,
  onChange,
  columnNames,
}: {
  readonly trigger: "board" | "schedule";
  readonly rows: ReadonlyArray<StepRow>;
  readonly onChange: (rows: StepRow[]) => void;
  /** Column names to offer for moves. */
  readonly columnNames: ReadonlyArray<string>;
}) {
  const allowed = STEPS_FOR[trigger];
  const replace = (id: number, step: AutomationStep) =>
    onChange(rows.map((row) => (row.id === id ? { id, step } : row)));
  const remove = (id: number) => onChange(rows.filter((row) => row.id !== id));
  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No steps yet.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {rows.map(({ id, step }, index) => (
            <li key={id} className="flex flex-wrap items-center gap-2">
              <span className="w-4 shrink-0 text-xs tabular-nums text-muted-foreground">
                {index + 1}.
              </span>
              <Select
                value={step.type}
                onValueChange={(value) => {
                  // The picker can report an empty value; only a known step replaces this one.
                  if (typeof value === "string" && value in STEP_LABEL && value !== step.type) {
                    replace(id, newStep(value as StepType, columnNames));
                  }
                }}
              >
                <SelectTrigger size="sm" className="w-44" aria-label={`Step ${index + 1}`}>
                  <SelectValue>{STEP_LABEL[step.type]}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {allowed.map((type) => (
                    <SelectItem key={type} value={type}>
                      {STEP_LABEL[type]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <StepFields
                step={step}
                columnNames={columnNames}
                onChange={(next) => replace(id, next)}
              />
              <Button
                aria-label={`Remove step ${index + 1}`}
                className="ml-auto"
                size="icon-xs"
                variant="ghost"
                onClick={() => remove(id)}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ol>
      )}
      <Button
        className="self-start"
        size="xs"
        variant="ghost"
        onClick={() => onChange([...rows, ...toStepRows([newStep(allowed[0]!, columnNames)])])}
      >
        <PlusIcon />
        Add step
      </Button>
    </div>
  );
}

function ColumnSelect({
  label,
  value,
  columnNames,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly columnNames: ReadonlyArray<string>;
  readonly onChange: (name: string) => void;
}) {
  const options = [...new Set([...columnNames, value])];
  return (
    <Select value={value} onValueChange={(next) => onChange(String(next))}>
      <SelectTrigger size="sm" className="w-36" aria-label={label}>
        <SelectValue>{value}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {options.map((name) => (
          <SelectItem key={name} value={name}>
            {name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function StepFields({
  step,
  columnNames,
  onChange,
}: {
  readonly step: AutomationStep;
  readonly columnNames: ReadonlyArray<string>;
  readonly onChange: (step: AutomationStep) => void;
}) {
  switch (step.type) {
    case "setStatus":
      return (
        <Select
          value={step.status}
          onValueChange={(value) => onChange({ ...step, status: value as TicketStatus })}
        >
          <SelectTrigger size="sm" className="w-36" aria-label="Status">
            <SelectValue>{STATUS_LABEL[step.status]}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {(Object.keys(STATUS_LABEL) as TicketStatus[]).map((status) => (
              <SelectItem key={status} value={status}>
                {STATUS_LABEL[status]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      );
    case "moveTo":
      return (
        <ColumnSelect
          label="Column"
          value={step.column}
          columnNames={columnNames}
          onChange={(column) => onChange({ ...step, column })}
        />
      );
    case "moveStale":
      return (
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          from
          <ColumnSelect
            label="From column"
            value={step.from}
            columnNames={columnNames}
            onChange={(from) => onChange({ ...step, from })}
          />
          to
          <ColumnSelect
            label="To column"
            value={step.to}
            columnNames={columnNames}
            onChange={(to) => onChange({ ...step, to })}
          />
          after
          <Input
            size="sm"
            type="number"
            min={1}
            className="w-16"
            aria-label="Days"
            value={step.olderThanDays}
            onChange={(event) =>
              onChange({ ...step, olderThanDays: Math.max(1, Number(event.target.value) || 1) })
            }
          />
          days
        </span>
      );
    case "removeWorkspace":
      return (
        <span className="text-xs text-muted-foreground">
          Only when everything is committed and pushed; branches are kept.
        </span>
      );
  }
}
