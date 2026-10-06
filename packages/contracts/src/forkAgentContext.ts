/**
 * Agent context (fork feature): what a thread's agent receives that the chat
 * does not show. That is the instructions T3 injects when the session starts
 * and the T3 tools it can call. The provider's own built-in prompt is not
 * visible to T3 and appears as a placeholder section.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ThreadId } from "./baseSchemas.ts";

export const FORK_AGENT_CONTEXT_WS_METHODS = {
  thread: "fork.agentContext.thread",
} as const;

export const AgentContextInstruction = Schema.Struct({
  title: Schema.String,
  /** How the provider receives it, such as "Appended to the system prompt". */
  channel: Schema.String,
  /** Null for a placeholder: text the provider adds itself and T3 cannot read. */
  text: Schema.NullOr(Schema.String),
});
export type AgentContextInstruction = typeof AgentContextInstruction.Type;

export const AgentContextTool = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  readonly: Schema.Boolean,
  /** False when settings switch the tool's capability off; calls then fail. */
  enabled: Schema.Boolean,
});
export type AgentContextTool = typeof AgentContextTool.Type;

export const ThreadAgentContext = Schema.Struct({
  providerName: Schema.String,
  /** False when T3 reproduces the text only approximately for this provider. */
  exact: Schema.Boolean,
  instructions: Schema.Array(AgentContextInstruction),
  tools: Schema.Array(AgentContextTool),
});
export type ThreadAgentContext = typeof ThreadAgentContext.Type;

export class AgentContextError extends Schema.TaggedError<AgentContextError>()(
  "AgentContextError",
  {
    code: Schema.Literals(["not-found", "unavailable"]),
    message: Schema.String,
  },
) {}

export const ForkAgentContextThreadRpc = Rpc.make(FORK_AGENT_CONTEXT_WS_METHODS.thread, {
  payload: Schema.Struct({ threadId: ThreadId }),
  success: ThreadAgentContext,
  error: Schema.Union([AgentContextError, EnvironmentAuthorizationError]),
});
