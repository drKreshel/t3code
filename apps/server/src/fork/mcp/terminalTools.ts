/**
 * Fork: `t3-code` MCP tools for agent-owned terminals. An agent starts a
 * long-running process (dev server, watcher) in a terminal tab of its thread,
 * where the user can watch it, and reads its output while debugging.
 */
import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { MAX_READ_LINES } from "../terminals/agentTerminalLogic.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    TerminalManager.TerminalManager,
    Path.Path,
  ],
};

const TerminalName = Schema.String.annotate({
  description:
    "Short lowercase name such as 'dev' or 'api' (letters, digits, dashes). The terminal id is 'agent-<name>'; either form is accepted.",
});

const AgentTerminalState = Schema.Literals(["running", "idle", "exited", "closed"]).annotate({
  description:
    "running: the command is still alive. idle: the command ended and the shell waits at its prompt. exited: the shell ended. closed: the terminal was closed; its saved output is still readable.",
});

const TerminalStartTool = Tool.make("t3_terminal_start", {
  ...shared,
  description:
    "Start a long-running command (dev server, watcher, long build) in a terminal tab of this thread. The user can watch and stop it there. Read its output with t3_terminal_read. Use your own shell for ordinary short commands. Starting a name that is idle reuses its shell; a name whose command is still running fails until it is stopped. Requires a full-access or auto thread in default mode.",
  parameters: Schema.Struct({
    command: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(8_000)),
    name: TerminalName,
    cwd: Schema.optional(
      Schema.String.annotate({
        description:
          "Working directory, absolute or relative to the thread's workspace. Defaults to the thread's worktree, or the project root.",
      }),
    ),
  }),
  success: Schema.Struct({
    terminalId: Schema.String,
    cwd: Schema.String,
  }),
}).annotate(Tool.Destructive, false);

const TerminalReadTool = Tool.make("t3_terminal_read", {
  ...shared,
  description:
    "Read the recent output of an agent terminal as plain text, with whether its command is still running. Pass threadId to read a terminal another thread in this project started.",
  parameters: Schema.Struct({
    name: TerminalName,
    lines: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
        .check(Schema.isLessThanOrEqualTo(MAX_READ_LINES))
        .annotate({ description: "Lines from the end to return. Defaults to 200." }),
    ),
    threadId: Schema.optional(ThreadId),
  }),
  success: Schema.Struct({
    terminalId: Schema.String,
    state: AgentTerminalState,
    cwd: Schema.NullOr(Schema.String),
    exitCode: Schema.NullOr(Schema.Int),
    output: Schema.String,
    truncated: Schema.Boolean,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const TerminalStopTool = Tool.make("t3_terminal_stop", {
  ...shared,
  description:
    "Stop the command in an agent terminal of this thread by sending Ctrl-C; the tab and its output stay. close=true also closes the terminal and its shell; its output stays readable.",
  parameters: Schema.Struct({
    name: TerminalName,
    close: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    terminalId: Schema.String,
    interrupted: Schema.Boolean.annotate({
      description: "Ctrl-C was sent to a running command. Read the terminal to confirm it ended.",
    }),
    closed: Schema.Boolean,
  }),
}).annotate(Tool.Destructive, true);

export const AgentTerminalToolkit = Toolkit.make(
  TerminalStartTool,
  TerminalReadTool,
  TerminalStopTool,
);
