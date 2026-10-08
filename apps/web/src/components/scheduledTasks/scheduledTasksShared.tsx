/** Pieces the Scheduled Tasks list and a task's page share (fork). */
import type { ModelSelection, ScheduledTaskRunState } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";

import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { TableHead } from "../ui/table";
import type { Sort } from "./scheduledTasks.logic";

export const STATE_LABEL: Record<ScheduledTaskRunState | "never", string> = {
  never: "Never ran",
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  stopped: "Stopped",
};

export function stateVariant(state: ScheduledTaskRunState | "never") {
  if (state === "failed") return "error";
  if (state === "succeeded") return "success";
  if (state === "running") return "info";
  return "outline";
}

export const formatWhen = (value: string) =>
  new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** The model and its options as one line, such as `gpt-5.6-sol · high`. */
export function modelLabel(selection: ModelSelection): string {
  const options = (selection.options ?? [])
    .map((option) => option.value)
    .filter((value): value is string => typeof value === "string" && value !== "");
  return [selection.model, ...options].join(" · ");
}

/** A column header that sorts the table; the arrow shows the current direction. */
export function SortableHead<Key extends string>({
  sortKey,
  sort,
  onSort,
  children,
}: {
  readonly sortKey: Key;
  readonly sort: Sort<Key>;
  readonly onSort: (key: Key) => void;
  readonly children: string;
}) {
  const active = sort.key === sortKey;
  return (
    <TableHead aria-sort={active ? (sort.descending ? "descending" : "ascending") : undefined}>
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={() => onSort(sortKey)}
      >
        {children}
        {active ? (
          sort.descending ? (
            <ArrowDownIcon className="size-3" />
          ) : (
            <ArrowUpIcon className="size-3" />
          )
        ) : null}
      </button>
    </TableHead>
  );
}

export function SearchField({
  value,
  placeholder,
  onChange,
}: {
  readonly value: string;
  readonly placeholder: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Input
      size="sm"
      type="search"
      className="w-64"
      value={value}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

const ALL = "all";

/** A select whose first choice, All, clears the filter. */
export function FilterSelect({
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
      <SelectTrigger size="sm" className="w-48" aria-label={`Filter by ${label.toLowerCase()}`}>
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
