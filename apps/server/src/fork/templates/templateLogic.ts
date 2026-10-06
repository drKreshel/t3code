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

/** A schedule's title on a board, so the Automations page tells boards apart. */
const scheduleTitle = (title: string, board: Board) => `${title} (${board.name})`;

type CreateAutomation = Extract<AutomationsCommand, { readonly type: "automation.create" }>;

/** A template's schedules, scoped to the new board. */
export function automationsForBoard(
  template: BoardTemplate,
  board: Board,
  serverTimezone: string,
): CreateAutomation[] {
  return template.automations.map((automation) => ({
    type: "automation.create" as const,
    prompt: automation.prompt,
    enabled: automation.enabled,
    title: scheduleTitle(automation.title, board),
    trigger: {
      type: "schedule" as const,
      schedule: automation.trigger.schedule,
      timezone: automation.trigger.timezone ?? serverTimezone,
    },
    action: {
      ...automation.action,
      steps: automation.action.steps?.map((step) => ({ ...step, boardId: board.id })),
    },
  }));
}

/** Whether a schedule only tidies this board, so it belongs in the board's template. */
function tidiesBoard(automation: Automation, boardId: string): boolean {
  const steps = automation.action.steps ?? [];
  return steps.length > 0 && steps.every((step) => step.boardId === boardId);
}

/** A board's columns and tidying schedules, as template parts. */
export function templatePartsOf(
  board: Board,
  automations: ReadonlyArray<Automation>,
): { readonly columns: ColumnSpec[]; readonly automations: TemplateAutomation[] } {
  const columns = board.columns.toSorted((a, b) => a.position - b.position);
  const suffix = ` (${board.name})`;
  const parts = automations
    .filter((automation) => tidiesBoard(automation, board.id))
    .map((automation): TemplateAutomation => ({
      prompt: automation.prompt,
      enabled: automation.enabled,
      title: automation.title.endsWith(suffix)
        ? automation.title.slice(0, -suffix.length)
        : automation.title,
      trigger: {
        type: "schedule",
        schedule: automation.trigger.schedule,
        timezone: automation.trigger.timezone,
      },
      action: {
        ...automation.action,
        steps: automation.action.steps?.map((step) => ({ ...step, boardId: null })),
      },
    }));
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
    description: "Delivery columns with scheduled cleanup: Done tickets settle after a week.",
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
      },
    ],
  },
];
