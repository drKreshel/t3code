/**
 * `t3-code` MCP tools for scheduled automations.
 * Writes go through AutomationEngine, like the UI's.
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
    description: "Like 'cron 0 9 * * 1-5 (Europe/Berlin)'.",
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
  description: "List scheduled T3 Code automations with their next run and last result.",
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
  description:
    "Create a scheduled automation. Give cron (five fields) or at (an ISO date-time), and optionally timezone. Chat runs need useThisChatsProject.",
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
    useThisChatsProject: Schema.optional(Schema.Boolean),
    checkout: Schema.optional(
      AutomationCheckout.annotate({
        description:
          "local (the project's checkout, default) or worktree (a new worktree per run).",
      }),
    ),
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
  description: "Run a scheduled automation now.",
  parameters: Schema.Struct({ automation: AutomationRef }),
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
