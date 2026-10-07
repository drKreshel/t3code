/**
 * Fork: pure helpers for agent terminals. Agents start long-running
 * processes in thread terminals named `agent-<name>`, so they show up as tabs
 * the user can watch, and only start or stop terminals carrying that prefix.
 * Reading reaches every terminal of the thread, including the user's `term-N`.
 */
import type { TerminalSummary } from "@t3tools/contracts";

export const AGENT_TERMINAL_PREFIX = "agent-";
export const AGENT_TERMINAL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const DEFAULT_READ_LINES = 200;
export const MAX_READ_LINES = 2_000;

export function agentTerminalId(name: string): string {
  return `${AGENT_TERMINAL_PREFIX}${name}`;
}

/** Accepts either the bare name or the full `agent-` id. */
export function resolveAgentTerminalId(nameOrId: string): string | null {
  const name = nameOrId.startsWith(AGENT_TERMINAL_PREFIX)
    ? nameOrId.slice(AGENT_TERMINAL_PREFIX.length)
    : nameOrId;
  return AGENT_TERMINAL_NAME_PATTERN.test(name) ? agentTerminalId(name) : null;
}

/**
 * Terminal ids to try, in order, when an agent reads `nameOrId`: the exact id
 * (a user terminal such as `term-1`), then the agent terminal of that name.
 */
export function readableTerminalIds(nameOrId: string): ReadonlyArray<string> {
  const agentId = resolveAgentTerminalId(nameOrId);
  return agentId === null || agentId === nameOrId ? [nameOrId] : [nameOrId, agentId];
}

export type AgentTerminalState = "running" | "idle" | "exited" | "closed";

/**
 * `running` means the started command is still alive; `idle` means it ended
 * and the shell waits at its prompt; `exited` means the shell itself ended.
 */
export function agentTerminalState(summary: TerminalSummary | null): AgentTerminalState {
  if (summary === null) return "closed";
  if (summary.status === "exited" || summary.status === "error") return "exited";
  return summary.hasRunningSubprocess ? "running" : "idle";
}

/** Shell input for a command; a newline is Enter for every shell's line editor. */
export function commandInput(command: string): string {
  return `${command.replace(/\r?\n/g, "\r")}\r`;
}

/**
 * Plain-text tail of terminal history: escape sequences removed, and each
 * carriage-return redraw (progress bars, spinners) collapsed to its last state.
 */
export function plainTerminalTail(
  history: string,
  lines: number,
): { readonly output: string; readonly truncated: boolean } {
  const plain = history
    .replace(
      // eslint-disable-next-line no-control-regex -- matching ANSI escape sequences is the point
      /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g,
      "",
    )
    .split(/\r?\n/)
    .map((line) => (line.split("\r").findLast((segment) => segment.length > 0) ?? "").trimEnd())
    .map((line) =>
      // eslint-disable-next-line no-control-regex -- strips control characters from terminal output
      line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ""),
    );
  while (plain.length > 0 && plain.at(-1) === "") plain.pop();
  const tail = plain.slice(-lines);
  return { output: tail.join("\n"), truncated: tail.length < plain.length };
}
