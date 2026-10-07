/**
 * Fork: `t3-code` MCP tools for chat pins. An agent pins the files and URLs
 * that matter on its chat and keeps short markdown notes current there; the
 * user sees them at a glance in the thread details card and on the chat's
 * ticket, however far the transcript scrolls.
 */
import {
  OrchestratorMcpFailure,
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
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";

// Pin tools act as the calling thread, so McpToolAccess may refuse the caller first.
const shared = {
  failure: Schema.Union([ThreadPinsError, OrchestratorMcpFailure]),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

const ChatPins = Schema.Struct({
  pins: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      target: Schema.NullOr(Schema.String).annotate({ description: "Null for a note." }),
    }),
  ),
}).annotate({ description: "This chat's pins, in order, after the change." });

const PinNoteTool = Tool.make("pin_note", {
  ...shared,
  description:
    "Pin a short markdown note on this chat, or rewrite the note with the same title. The user reads pinned notes at a glance beside the chat and on its ticket, such as where things run ('dev server on :4000'), current status, or the decisions you need from them. Absolute file paths written as markdown links and $skill names show as chips. Rewrite a note when it goes stale and unpin it when nothing is left.",
  parameters: Schema.Struct({
    title: TrimmedNonEmptyString.check(Schema.isMaxLength(THREAD_PIN_TITLE_MAX_LENGTH)).annotate({
      description:
        "Short label such as 'Status' or 'Decisions needed'. Reusing a title replaces that note.",
    }),
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(THREAD_NOTE_MAX_LENGTH)).annotate({
      description: "The whole note in markdown; it replaces the previous text.",
    }),
  }),
  success: ChatPins,
})
  .annotate(Tool.Title, "Pin note")
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
  description:
    "Remove a pin (file, URL, or note) from this chat when it no longer matters. A pinned file itself stays.",
  parameters: Schema.Struct({
    pin: TrimmedNonEmptyString.annotate({
      description: "The pin's id, its file path or URL, or a note's title.",
    }),
  }),
  success: ChatPins,
})
  .annotate(Tool.Title, "Unpin artifact")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ThreadPinsToolkit = Toolkit.make(PinNoteTool, PinArtifactTool, UnpinArtifactTool);
