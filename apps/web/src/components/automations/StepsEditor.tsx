import type { AutomationStep } from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/** A step with a key for its row; steps themselves carry no ids. */
export interface StepRow {
  readonly id: number;
  readonly step: AutomationStep;
}

let nextRowId = 0;
/** Rows for scheduled cleanup. */
export function toStepRows(steps: ReadonlyArray<AutomationStep>): StepRow[] {
  return steps.map((step) => ({ id: nextRowId++, step }));
}

/**
 * Scheduled cleanup runs instead of a chat. It costs no tokens; the first
 * failure stops the remaining steps.
 */
export function StepsEditor({
  rows,
  onChange,
  columnNames,
  boardNameOf,
}: {
  readonly rows: ReadonlyArray<StepRow>;
  readonly onChange: (rows: StepRow[]) => void;
  /** Column names to offer for moves. */
  readonly columnNames: ReadonlyArray<string>;
  readonly boardNameOf: (boardId: string) => string;
}) {
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
              <span className="text-xs">Move old tickets</span>
              <StepFields
                step={step}
                columnNames={columnNames}
                boardNameOf={boardNameOf}
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
        onClick={() =>
          onChange([
            ...rows,
            ...toStepRows([{ type: "moveStale", from: "Done", to: "Settled", olderThanDays: 7 }]),
          ])
        }
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
  boardNameOf,
  onChange,
}: {
  readonly step: AutomationStep;
  readonly columnNames: ReadonlyArray<string>;
  readonly boardNameOf: (boardId: string) => string;
  readonly onChange: (step: AutomationStep) => void;
}) {
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
      days, on {step.boardId ? boardNameOf(step.boardId) : "every board"}
    </span>
  );
}
