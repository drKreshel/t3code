/**
 * Turning boards into templates and templates into automations. Pure, so the
 * service only stores and dispatches.
 */
import {
  type AutomationAction,
  type Automation,
  type AutomationsCommand,
  type Board,
  type BoardTemplate,
  type ColumnSpec,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type TemplateAutomation,
} from "@t3tools/contracts";
import { instructionsFromAutomation } from "../automations/workflowLogic.ts";

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A schedule's title on a board, so the Automations page tells boards apart. */
const scheduleTitle = (title: string, board: Board) => `${title} (${board.name})`;

type CreateAutomation = Extract<AutomationsCommand, { readonly type: "automation.create" }>;

/** The automations a template makes for a new board. Hooks on missing columns are skipped. */
export function automationsForBoard(
  template: BoardTemplate,
  board: Board,
  serverTimezone: string,
): CreateAutomation[] {
  return template.automations.flatMap((automation): CreateAutomation[] => {
    const base = {
      type: "automation.create" as const,
      prompt: automation.prompt,
      enabled: automation.enabled,
      maxRunsPerTicket: automation.maxRunsPerTicket,
    };
    if (automation.trigger.type === "board") {
      const columnName = automation.trigger.column;
      const column = board.columns.find((candidate) => sameName(candidate.name, columnName));
      if (!column) return [];
      const { steps: _steps, ...action } = automation.action;
      return [
        {
          ...base,
          title: scheduleTitle(automation.title, board),
          trigger: { type: "workflow" as const },
          prompt: instructionsFromAutomation(automation.prompt, automation.action),
          action: {
            ...action,
            checkout: action.checkout === "worktree" ? "ticket" : action.checkout,
          },
        },
      ];
    }
    return [
      {
        ...base,
        title: scheduleTitle(automation.title, board),
        trigger: {
          type: "schedule" as const,
          schedule: automation.trigger.schedule,
          timezone: automation.trigger.timezone ?? serverTimezone,
        },
        action: {
          ...automation.action,
          steps: automation.action.steps?.map((step) =>
            step.type === "moveStale" ? { ...step, boardId: board.id } : step,
          ),
        },
      },
    ];
  });
}

/** Whether a schedule only tidies this board, so it belongs in the board's template. */
function tidiesBoard(automation: Automation, boardId: string): boolean {
  const steps = automation.action.steps ?? [];
  return (
    automation.trigger.type === "schedule" &&
    steps.length > 0 &&
    steps.every((step) => step.type === "moveStale" && step.boardId === boardId)
  );
}

/**
 * A board's columns, hooks, and tidying schedules, as template parts. Hooks
 * drop their project so each board's own project applies.
 */
export function templatePartsOf(
  board: Board,
  automations: ReadonlyArray<Automation>,
): { readonly columns: ColumnSpec[]; readonly automations: TemplateAutomation[] } {
  const columns = board.columns.toSorted((a, b) => a.position - b.position);
  const parts = automations.flatMap((automation): TemplateAutomation[] => {
    const shared = {
      prompt: automation.prompt,
      enabled: automation.enabled,
      maxRunsPerTicket: automation.maxRunsPerTicket,
    };
    const { trigger } = automation;
    if (trigger.type === "board" && trigger.boardId === board.id) {
      const column = columns.find((candidate) => candidate.id === trigger.columnId);
      if (!column) return [];
      return [
        {
          ...shared,
          title: automation.title,
          trigger: { type: "board", column: column.name },
          action: { ...automation.action, projectKey: null },
        },
      ];
    }
    if (trigger.type === "schedule" && tidiesBoard(automation, board.id)) {
      const suffix = ` (${board.name})`;
      return [
        {
          ...shared,
          title: automation.title.endsWith(suffix)
            ? automation.title.slice(0, -suffix.length)
            : automation.title,
          trigger: { type: "schedule", schedule: trigger.schedule, timezone: trigger.timezone },
          action: {
            ...automation.action,
            steps: automation.action.steps?.map((step) =>
              step.type === "moveStale" ? { ...step, boardId: null } : step,
            ),
          },
        },
      ];
    }
    return [];
  });
  return {
    columns: columns.map((column) => ({ name: column.name, color: column.color })),
    automations: parts,
  };
}

/** Defaults for scheduled cleanup steps that do not start a chat. */
const STEPS_ACTION: AutomationAction = {
  projectKey: null,
  modelSelection: null,
  runtimeMode: DEFAULT_RUNTIME_MODE,
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  checkout: "local",
};

export const BUILT_IN_TEMPLATES: ReadonlyArray<BoardTemplate> = [
  {
    id: "builtin:basic",
    name: "Basic",
    description: "Plain columns and no automations.",
    builtIn: true,
    columns: [
      { name: "Backlog", color: null },
      { name: "Todo", color: null },
      { name: "In progress", color: "blue" },
      { name: "Review", color: "violet" },
      { name: "Done", color: "green" },
    ],
    automations: [],
  },
  {
    id: "builtin:ship",
    name: "Ship with agents",
    description:
      "Delivery columns with scheduled cleanup. Choose a workflow on each ticket; Done tickets settle after a week.",
    builtIn: true,
    columns: [
      { name: "Backlog", color: null },
      { name: "Todo", color: "slate" },
      { name: "In Progress", color: "blue" },
      { name: "Review", color: "violet" },
      { name: "Ready", color: "teal" },
      { name: "Close", color: "orange" },
      { name: "Push", color: "cyan" },
      { name: "Done", color: "green" },
      { name: "Settled", color: "gray" },
      { name: "Cancelled", color: "red" },
    ],
    automations: [
      {
        title: "Settle old Done tickets",
        prompt: "",
        trigger: {
          type: "schedule",
          schedule: { kind: "cron", cron: "0 6 * * *" },
          timezone: null,
        },
        action: {
          ...STEPS_ACTION,
          steps: [{ type: "moveStale", from: "Done", to: "Settled", olderThanDays: 7 }],
        },
        enabled: true,
        maxRunsPerTicket: 5,
      },
    ],
  },
];
