import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type TicketWorkflow,
  type AutomationAction,
} from "@t3tools/contracts";

const action = {
  projectKey: null,
  modelSelection: null,
  runtimeMode: DEFAULT_RUNTIME_MODE,
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  checkout: "ticket" as const,
};

export const DEFAULT_WORKFLOWS: ReadonlyArray<TicketWorkflow> = [
  {
    presetId: "builtin:simple-fix",
    title: "Simple fix",
    action,
    prompt:
      "Read the ticket and latest handoff. Implement the requested change, run focused checks, and check off verified acceptance criteria. Record what changed and how it was verified in a handoff comment. Move to In Progress while working and Done when complete, if those columns exist. Use one session unless the task needs delegation. If blocked, call request_human. Do not push or publish unless the ticket authorizes it.",
  },
  {
    presetId: "builtin:feature-workflow",
    title: "Feature workflow",
    action,
    prompt:
      "Read the ticket and latest handoff. Implement the feature and run focused checks, recording progress in the ticket. Move to In Progress while implementing and Review while reviewing, if those columns exist. Delegate a fresh review, with the ticket key, workspace, acceptance criteria, and instructions to record findings in a handoff comment. Address confirmed findings in this original session and request another review when needed. Choose providers and models from orchestrator_capabilities, respecting any choices in the ticket. Stop and call request_human when a decision or permission is needed. When implementation and review pass, check off verified criteria, record verification and remaining delivery steps, and move to Ready (or Done if Ready does not exist). If delivery still needs authorization, call request_human and wait for Resume. On Resume, read the latest handoff and continue the remaining work; do not repeat completed stages. Push, merge, or publish only when authorized by the ticket or user.",
  },
  {
    presetId: "builtin:review-only",
    title: "Review only",
    action,
    prompt:
      "Read the ticket and latest handoff. Review the requested changes or subject, run appropriate checks, and record concrete findings and evidence in a handoff comment on the ticket. Move to Review while working and Done when the review is complete, if those columns exist. Check off criteria that the review verifies. Make changes only when the ticket asks for them. If blocked, call request_human.",
  },
];

export function workflowPrompt(instructions: string, resumed: boolean): string {
  return [
    resumed
      ? "Resume this ticket's workflow from its latest handoff."
      : "Start this ticket's workflow.",
    "Read get_ticket before acting. The ticket is the shared work history: record decisions, verification, findings, blockers, and handoffs there, with links to relevant chats. Column moves record progress; they do not launch agents. You own execution and may delegate according to the instructions. Give delegated agents the ticket key and workspace, link their sessions to the ticket, and require a handoff comment. Use request_human only when completely blocked from continuing without the user; it marks this chat Needs you. The user can reply or Resume here to continue. Use the provider question tool for ordinary questions. A completed chat turn does not by itself mean the ticket is done.",
    instructions,
  ].join("\n\n");
}

/** Old built-in hook actions become instructions when imported as a preset. */
export function instructionsFromAutomation(prompt: string, action: AutomationAction): string {
  return [
    prompt,
    ...(action.steps ?? []).map((step) => {
      if (step.type === "moveTo") return `Move the ticket to ${step.column}.`;
      if (step.type === "removeWorkspace")
        return "Remove the ticket workspace once its work is saved and delivered.";
      return `Settle tickets older than ${step.olderThanDays} days from ${step.from} to ${step.to}.`;
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
}
