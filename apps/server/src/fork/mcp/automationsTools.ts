/**
 * `t3-code` MCP tools for automations (fork): scheduled chats and board
 * column hooks. Writes go through AutomationEngine, like the UI's.
 */
import {
  AutomationCheckout,
  AutomationRunStatus,
  AutomationsCommandError,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  Orchestrator.OrchestratorV2,
  ProjectStore.ProjectStoreV2,
];

const failure = AutomationsCommandError;

const AutomationRef = TrimmedNonEmptyString.annotate({
  description: "The automation's id or exact title.",
});

export const AutomationSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  enabled: Schema.Boolean,
  trigger: Schema.String.annotate({
    description: "Like 'cron 0 9 * * 1-5 (Europe/Berlin)' or 'ticket enters WEB › In progress'.",
  }),
  prompt: Schema.String,
  project: Schema.NullOr(Schema.String),
  nextRunAt: Schema.NullOr(Schema.String),
  lastRun: Schema.NullOr(
    Schema.Struct({
      status: AutomationRunStatus,
      reason: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  ),
});
export type AutomationSummary = typeof AutomationSummary.Type;

const Changed = Schema.Struct({ id: Schema.String, title: Schema.String });

const ListAutomationsTool = Tool.make("list_automations", {
  description:
    "List T3 Code automations: scheduled chats and board hooks (a chat started when a ticket enters a column), with their trigger, next run, and last run.",
  success: Schema.Struct({ automations: Schema.Array(AutomationSummary) }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "List automations")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CreateAutomationTool = Tool.make("create_automation", {
  description: [
    "Create an automation that starts a new chat with the prompt. Give exactly one trigger:",
    "- cron (five fields: minute hour day-of-month month day-of-week, e.g. '0 9 * * 1-5' for weekdays at 9:00) or at (an ISO date-time, runs once), read in timezone;",
    "- board + column: runs when a ticket enters that column, linked to the ticket. board '*' means every board; then column is matched by name on each board. Its prompt can use {{ticket.key}}, {{ticket.title}}, {{ticket.description}}, {{ticket.criteria}}, {{ticket.handoff}}, {{ticket.url}}, {{board.name}}, {{run.number}}.",
    "Scheduled automations need a project: set useThisChatsProject. Board hooks default to the ticket's, then the board's project.",
  ].join("\n"),
  parameters: Schema.Struct({
    title: TrimmedNonEmptyString,
    prompt: TrimmedNonEmptyString,
    cron: Schema.optional(TrimmedNonEmptyString),
    at: Schema.optional(TrimmedNonEmptyString),
    timezone: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "IANA zone like Europe/Berlin. Defaults to the server's zone.",
      }),
    ),
    board: Schema.optional(
      TrimmedNonEmptyString.annotate({ description: "Board key like WEB, or * for every board." }),
    ),
    column: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "Column name or type, like In progress or active.",
      }),
    ),
    useThisChatsProject: Schema.optional(Schema.Boolean),
    checkout: Schema.optional(
      AutomationCheckout.annotate({
        description:
          "local (the project's checkout, default) or worktree (a new worktree per run).",
      }),
    ),
    maxRunsPerTicket: Schema.optional(Schema.Int),
    enabled: Schema.optional(Schema.Boolean),
  }),
  success: Changed,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Create automation")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const UpdateAutomationTool = Tool.make("update_automation", {
  description:
    "Change an automation: enable or disable it, rename it, change its prompt, or change its schedule (cron or at, and timezone).",
  parameters: Schema.Struct({
    automation: AutomationRef,
    enabled: Schema.optional(Schema.Boolean),
    title: Schema.optional(TrimmedNonEmptyString),
    prompt: Schema.optional(TrimmedNonEmptyString),
    cron: Schema.optional(TrimmedNonEmptyString),
    at: Schema.optional(TrimmedNonEmptyString),
    timezone: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Changed,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Update automation")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DeleteAutomationTool = Tool.make("delete_automation", {
  description: "Delete an automation and its run history. Prefer disabling when unsure.",
  parameters: Schema.Struct({ automation: AutomationRef }),
  success: Changed,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Delete automation")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RunAutomationTool = Tool.make("run_automation", {
  description: "Run an automation now. A board hook needs the ticket to run for.",
  parameters: Schema.Struct({
    automation: AutomationRef,
    ticket: Schema.optional(
      TrimmedNonEmptyString.annotate({ description: "Ticket key like WEB-12." }),
    ),
  }),
  success: Changed,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Run automation now")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const AutomationsToolkit = Toolkit.make(
  ListAutomationsTool,
  CreateAutomationTool,
  UpdateAutomationTool,
  DeleteAutomationTool,
  RunAutomationTool,
);
