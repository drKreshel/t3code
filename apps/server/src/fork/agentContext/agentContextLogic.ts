/**
 * Fork: rebuilds what a thread's agent receives at session start that the chat
 * does not show, from the same builders the adapters use.
 */
import type { AgentContextInstruction, AgentContextTool } from "@t3tools/contracts";
import * as Context from "effect/Context";
import { Tool } from "effect/ai";

import { claudeSystemPromptAppend } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  buildCodexAdditionalContext,
  buildCodexDeveloperInstructions,
} from "../../provider/CodexDeveloperInstructions.ts";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import { AttachmentToolkit } from "../../mcp/toolkits/attachment/tools.ts";
import { DeviceToolkit } from "../../mcp/toolkits/device/tools.ts";
import { EnvironmentToolkit } from "../../mcp/toolkits/environment/tools.ts";
import { OrchestratorToolkit } from "../../mcp/toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "../../mcp/toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "../../mcp/toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "../../mcp/toolkits/project/tools.ts";
import { PullRequestsToolkit } from "../../mcp/toolkits/pullRequests/tools.ts";
import { ThreadToolkit } from "../../mcp/toolkits/thread/tools.ts";
import { WorktreeToolkit } from "../../mcp/toolkits/worktree/tools.ts";
import { BoardsToolkit } from "../mcp/boardsTools.ts";
import { AgentTerminalToolkit } from "../mcp/terminalTools.ts";
import { ThreadPinsToolkit } from "../mcp/pinsTools.ts";

export interface AgentSessionInput {
  readonly driverKind: string;
  readonly providerName: string;
  readonly interactionMode: "default" | "plan";
  readonly model: string;
  readonly reasoningEffort: string | undefined;
  readonly browser: boolean;
  readonly device: boolean;
}

const placeholder = (providerName: string, channel: string): AgentContextInstruction => ({
  title: `${providerName} instructions`,
  channel,
  text: null,
});

/** The session-start instructions, in the order the provider receives them. */
export function agentInstructions(input: AgentSessionInput): {
  readonly exact: boolean;
  readonly instructions: ReadonlyArray<AgentContextInstruction>;
} {
  switch (input.driverKind) {
    case "claudeAgent":
      return {
        exact: true,
        instructions: [
          placeholder(
            "Claude Code",
            "Built into Claude Code: its system prompt, CLAUDE.md files, memory, and the skill list",
          ),
          {
            title: "Added by T3",
            channel: "Appended to the system prompt",
            text: claudeSystemPromptAppend(true),
          },
        ],
      };
    case "codex": {
      const context = buildCodexAdditionalContext(
        { model: input.model, reasoningEffort: input.reasoningEffort ?? "medium" },
        { browser: input.browser, device: input.device },
      );
      return {
        exact: true,
        instructions: [
          placeholder("Codex", "Built into Codex: its system prompt, AGENTS.md files, and skills"),
          ...Object.entries(context).map(([key, entry]) => ({
            title: key,
            channel: "Additional context, sent as a developer message",
            text: entry.value,
          })),
          {
            title: `Collaboration mode: ${input.interactionMode}`,
            channel: "Developer instructions; newer models may use their own text instead",
            text: buildCodexDeveloperInstructions(input.interactionMode),
          },
        ],
      };
    }
    default: {
      const channel = "Added by T3; how it is wrapped and sent depends on the provider";
      return {
        exact: false,
        instructions: [
          placeholder(input.providerName, `Built into ${input.providerName}`),
          { title: "T3 orchestration", channel, text: T3_CODE_ORCHESTRATION_INSTRUCTIONS },
          {
            title: "Runtime info",
            channel,
            text: buildRuntimeInstructions({ harness: input.providerName, model: input.model }),
          },
        ],
      };
    }
  }
}

// Every toolkit McpHttpServer registers, with the capability its calls need.
const TOOLKITS = [
  { toolkit: OrchestratorToolkit, capability: null },
  { toolkit: ThreadToolkit, capability: null },
  { toolkit: AttachmentToolkit, capability: null },
  { toolkit: ProjectToolkit, capability: null },
  { toolkit: EnvironmentToolkit, capability: null },
  { toolkit: PreviewControlsToolkit, capability: null },
  { toolkit: WorktreeToolkit, capability: null },
  { toolkit: PullRequestsToolkit, capability: null },
  { toolkit: BoardsToolkit, capability: null },
  { toolkit: AgentTerminalToolkit, capability: null },
  { toolkit: ThreadPinsToolkit, capability: null },
  { toolkit: PreviewToolkit, capability: "browser" },
  { toolkit: DeviceToolkit, capability: "device" },
] as const;

/** The `t3-code` MCP tools every thread is offered; settings disable browser and device tools. */
export function t3Tools(access: {
  readonly browser: boolean;
  readonly device: boolean;
}): ReadonlyArray<AgentContextTool> {
  return TOOLKITS.flatMap(({ toolkit, capability }) =>
    Object.values(toolkit.tools as Record<string, Tool.Any>).map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      readonly: Context.get(tool.annotations, Tool.Readonly),
      enabled: capability === null || access[capability],
    })),
  );
}
