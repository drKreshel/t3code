import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { layerMemory } from "../threadPins/ThreadPinsService.ts";
import { ThreadPinsToolkitHandlersLive } from "./pinsHandlers.ts";
import { ThreadPinsToolkit } from "./pinsTools.ts";

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  client: undefined,
  thread: {
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

/** Calls a pins tool as the given MCP caller and returns its result. */
const tools = Effect.gen(function* () {
  const toolkit = yield* ThreadPinsToolkit;
  return <Name extends keyof typeof ThreadPinsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    scope = invocation,
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!.result),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    );
});

// The calling thread has a live run, so McpToolAccess lets it act.
const liveThread = {
  id: ThreadId.make("thread-1"),
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  activeRunId: RunId.make("run-1"),
  runtimeMode: "full-access",
  interactionMode: "default",
  archivedAt: null,
  deletedAt: null,
} as unknown as OrchestrationV2ThreadShell;

const TestLayer = McpToolAccess.HandlersLayer.layer(ThreadPinsToolkitHandlersLive).pipe(
  Layer.provideMerge(layerMemory),
  Layer.provideMerge(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(liveThread),
    }),
  ),
  Layer.provide(NodeServices.layer),
);

describe("chat pins tools", () => {
  it.layer(TestLayer)((it) => {
    it.effect("pins files and notes to the calling chat and unpins by target or title", () =>
      Effect.gen(function* () {
        const call = yield* tools;
        yield* call("pin_artifact", { title: "Smoke test guide", target: "/tmp/smoke.md" });
        expect(
          yield* call("pin_note", { title: "Status", text: "Dev server on :4000" }),
        ).toMatchObject({
          pins: [
            { title: "Smoke test guide", target: "/tmp/smoke.md" },
            { title: "Status", target: null },
          ],
        });
        yield* call("unpin_artifact", { pin: "/tmp/smoke.md" });
        expect(yield* call("unpin_artifact", { pin: "Status" })).toMatchObject({ pins: [] });
      }),
    );

    it.effect("refuses callers outside a T3 thread", () =>
      Effect.gen(function* () {
        const call = yield* tools;
        const error = yield* call(
          "pin_note",
          { title: "Note", text: "hello" },
          { ...invocation, thread: undefined },
        ).pipe(Effect.flip);
        expect(error).toMatchObject({ code: "thread_credential_required" });
      }),
    );
  });
});
