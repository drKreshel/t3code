/**
 * Fork: `t3-code` MCP tools for chat pins. An agent keeps a short note and
 * pins the artifacts that matter on its chat; the user sees both at a glance
 * in the thread details card and on the chat's ticket, however far the
 * transcript scrolls.
 */
import {
  THREAD_NOTE_MAX_LENGTH,
  THREAD_PIN_TARGET_MAX_LENGTH,
  THREAD_PIN_TITLE_MAX_LENGTH,
  ThreadPinsError,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";

const shared = {
  failure: ThreadPinsError,
  dependencies: [McpInvocationContext.McpInvocationContext],
};

const ChatPins = Schema.Struct({
  note: Schema.NullOr(Schema.String),
  pins: Schema.Array(
    Schema.Struct({ id: Schema.String, title: Schema.String, target: Schema.String }),
  ),
}).annotate({ description: "This chat's note and pins after the change." });

const SetChatNoteTool = Tool.make("set_chat_note", {
  ...shared,
  description:
    "Replace this chat's note: a few short lines the user reads at a glance beside the chat and on its ticket, such as where things run ('dev server on :4000'), current status, or the decisions you need from them. Rewrite it whenever it goes stale; an empty note clears it. Short markdown (bold, lists, links, inline code), not a file.",
  parameters: Schema.Struct({
    note: Schema.String.check(Schema.isMaxLength(THREAD_NOTE_MAX_LENGTH)).annotate({
      description: "The whole note; it replaces the previous one. Empty clears it.",
    }),
  }),
  success: ChatPins,
})
  .annotate(Tool.Title, "Set chat note")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PinArtifactTool = Tool.make("pin_artifact", {
  ...shared,
  description:
    "Pin an artifact the user should keep at hand for this chat, such as a smoke test guide, plan, report, or a running app or PR URL. Pins stay visible beside the chat and on its ticket however long the chat grows. Pin only what the user will come back to. Pinning the same target again renames it.",
  parameters: Schema.Struct({
    title: TrimmedNonEmptyString.check(Schema.isMaxLength(THREAD_PIN_TITLE_MAX_LENGTH)).annotate({
      description: "Short label, such as 'Smoke test guide'.",
    }),
    target: TrimmedNonEmptyString.check(Schema.isMaxLength(THREAD_PIN_TARGET_MAX_LENGTH)).annotate({
      description: "Absolute file path, or an http(s) URL.",
    }),
  }),
  success: ChatPins,
})
  .annotate(Tool.Title, "Pin artifact")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnpinArtifactTool = Tool.make("unpin_artifact", {
  ...shared,
  description: "Remove a pin from this chat when it no longer matters. The file itself stays.",
  parameters: Schema.Struct({
    pin: TrimmedNonEmptyString.annotate({ description: "The pin's id or its target." }),
  }),
  success: ChatPins,
})
  .annotate(Tool.Title, "Unpin artifact")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ThreadPinsToolkit = Toolkit.make(SetChatNoteTool, PinArtifactTool, UnpinArtifactTool);
