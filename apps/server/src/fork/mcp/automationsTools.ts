/**
 * `t3-code` MCP tools for scheduled automations and ticket workflow presets.
 * Writes go through AutomationEngine, like the UI's.
 */
import {
  AutomationCheckout,
  AutomationRunStatus,
  AutomationsCommandError,
  AutomationAction,
  ModelSelection,
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

const WorkflowRef = TrimmedNonEmptyString.annotate({
  description: "Workflow preset id or exact title.",
});
const ListWorkflowsTool = Tool.make("list_workflows", {
  description:
    "List reusable ticket workflow presets. Instructions are copied onto tickets when selected; column moves do not execute them.",
  success: Schema.Struct({
    workflows: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        instructions: Schema.String,
        action: AutomationAction,
      }),
    ),
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CreateWorkflowTool = Tool.make("create_workflow", {
  description:
    "Create a reusable ticket workflow preset. Write the complete process as instructions, including delegation, models, handoffs, stopping conditions and any human approvals. Creating a preset does not start work. Use orchestrator_capabilities for model ids.",
  parameters: Schema.Struct({
    title: TrimmedNonEmptyString,
    instructions: TrimmedNonEmptyString,
    modelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
    checkout: Schema.optional(Schema.Literals(["local", "ticket"])),
  }),
  success: Changed,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Idempotent, false);

const UpdateWorkflowTool = Tool.make("update_workflow", {
  description:
    "Edit a workflow preset. Assigned tickets keep their existing instruction copies until explicitly reassigned. enabled=false retires the preset while preserving tickets and history.",
  parameters: Schema.Struct({
    workflow: WorkflowRef,
    title: Schema.optional(TrimmedNonEmptyString),
    instructions: Schema.optional(TrimmedNonEmptyString),
    modelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
    checkout: Schema.optional(Schema.Literals(["local", "ticket"])),
    enabled: Schema.optional(Schema.Boolean),
  }),
  success: Changed,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Idempotent, true);

const StartWorkflowTool = Tool.make("start_workflow", {
  description:
    "Explicitly start or resume a ticket's selected workflow. Resumes its existing workflow chat, prevents duplicate execution, and clears its pause flag. Defaults to this chat's linked ticket. Read the ticket and dependencies before starting. Column moves never start work.",
  parameters: Schema.Struct({ ticket: Schema.optional(TrimmedNonEmptyString) }),
  success: Schema.Struct({
    ticket: Schema.String,
    threadKey: Schema.NullOr(Schema.String),
    runId: Schema.String,
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Idempotent, false);

const PauseWorkflowTool = Tool.make("pause_workflow", {
  description:
    "Pause a ticket workflow's current turn and hold its queued messages. Defaults to this chat's linked ticket. Resume with start_workflow.",
  parameters: Schema.Struct({ ticket: Schema.optional(TrimmedNonEmptyString) }),
  success: Schema.Struct({ ticket: Schema.String }),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Idempotent, true);

const ListAutomationsTool = Tool.make("list_automations", {
  description:
    "List scheduled T3 Code automations with their next run and last result. Use list_workflows for ticket instruction presets.",
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
    "Create a scheduled automation. Give cron (five fields) or at (an ISO date-time), and optionally timezone. Chat runs need useThisChatsProject. For ticket execution use workflow presets and start_workflow.",
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
  description: "Run a scheduled automation now. Use start_workflow to run a ticket workflow.",
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
  ListWorkflowsTool,
  CreateWorkflowTool,
  UpdateWorkflowTool,
  StartWorkflowTool,
  PauseWorkflowTool,
  ListAutomationsTool,
  CreateAutomationTool,
  UpdateAutomationTool,
  DeleteAutomationTool,
  RunAutomationTool,
);
