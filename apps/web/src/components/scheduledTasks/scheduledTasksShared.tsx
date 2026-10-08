/** Pieces the Scheduled Tasks list and a task's page share (fork). */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { formatModelSelectionEffort } from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId, ModelSelection, ScheduledTaskRunState } from "@t3tools/contracts";
import { formatModelSlugName, resolveSelectableModel } from "@t3tools/shared/model";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { Atom } from "effect/reactivity";
import { useCallback } from "react";

import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import { ProjectFavicon } from "../ProjectFavicon";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { TableHead } from "../ui/table";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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

const NO_PROVIDERS_ATOM = Atom.make(EMPTY_SERVER_PROVIDERS).pipe(
  Atom.withLabel("scheduled-tasks:no-providers"),
);

export interface ModelLabel {
  readonly model: string;
  /** Null when the provider does not describe an effort for the model. */
  readonly effort: string | null;
}

/**
 * Names a model selection the way the composer does, such as `GPT-5.6 Sol` and
 * `High`, with the effort resolved to the model's default when none is stored.
 */
export function useModelLabel(
  environmentId: EnvironmentId | null,
): (selection: ModelSelection) => ModelLabel {
  const providers =
    useAtomValue(
      environmentId ? serverEnvironment.providersValueAtom(environmentId) : NO_PROVIDERS_ATOM,
    ) ?? EMPTY_SERVER_PROVIDERS;
  return useCallback(
    (selection) => {
      const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
      const models = provider?.models ?? [];
      const slug = provider
        ? resolveSelectableModel(provider.driver, selection.model, models)
        : null;
      const catalogModel = models.find((model) => model.slug === slug);
      return {
        model: catalogModel
          ? getTriggerDisplayModelName(catalogModel)
          : formatModelSlugName(selection.model),
        effort: formatModelSelectionEffort(selection, models),
      };
    },
    [providers],
  );
}

export const formatModelLabel = (label: ModelLabel) =>
  label.effort ? `${label.model} · ${label.effort}` : label.model;

/** The model with its effort quieter beside it. */
export function ModelText({ label }: { readonly label: ModelLabel }) {
  return (
    <span className="flex items-baseline gap-1.5 whitespace-nowrap">
      <span>{label.model}</span>
      {label.effort ? <span className="text-muted-foreground">{label.effort}</span> : null}
    </span>
  );
}

/** The project's icon, with its name on hover; the name alone when the project is gone. */
export function ProjectIcon({
  project,
  fallbackTitle,
}: {
  readonly project: EnvironmentProject | undefined;
  readonly fallbackTitle: string;
}) {
  if (!project) return <span className="text-muted-foreground">{fallbackTitle}</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" aria-label={project.title} />}>
        <ProjectFavicon project={project} className="size-4" />
      </TooltipTrigger>
      <TooltipPopup>{project.title}</TooltipPopup>
    </Tooltip>
  );
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
