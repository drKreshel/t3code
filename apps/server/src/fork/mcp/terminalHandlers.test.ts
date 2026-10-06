import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project,
  type RuntimeMode,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { AgentTerminalToolkitHandlersLive } from "./terminalHandlers.ts";
import { AgentTerminalToolkit } from "./terminalTools.ts";

const THREAD_ID = ThreadId.make("thread-1");
const PROJECT_ID = ProjectId.make("project-1");
const PROVIDER = ProviderInstanceId.make("claudeAgent");

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  client: undefined,
  thread: {
    threadId: THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: PROVIDER,
  },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

/** Records what the tools ask of the terminal manager and fakes the terminal it would run. */
const makeHarness = (runtimeMode: RuntimeMode, scope = invocation) =>
  Effect.gen(function* () {
    const writes: Array<string> = [];
    const opened: Array<string> = [];
    let summary: TerminalSummary | null = null;
    const thread = {
      id: THREAD_ID,
      projectId: PROJECT_ID,
      worktreePath: "/work/tree",
      runtimeMode,
      interactionMode: "default",
      providerInstanceId: PROVIDER,
      activeRunId: RunId.make("run-1"),
      archivedAt: null,
      deletedAt: null,
    } as unknown as OrchestrationV2ThreadShell;
    const services = Layer.mergeAll(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(thread),
      }),
      Layer.mock(ProjectService.ProjectService)({
        getById: () => Effect.succeed(Option.some({ workspaceRoot: "/work/root" } as Project)),
      }),
      Layer.mock(TerminalManager.TerminalManager)({
        read: () => Effect.succeed({ summary, history: summary ? "$ pnpm dev\r\nready\r\n" : "" }),
        open: (input) =>
          Effect.sync(() => {
            opened.push(input.cwd);
            summary = {
              threadId: input.threadId,
              terminalId: input.terminalId,
              cwd: input.cwd,
              worktreePath: input.worktreePath ?? null,
              status: "running",
              pid: 9000,
              exitCode: null,
              exitSignal: null,
              hasRunningSubprocess: true,
              label: "node",
              updatedAt: "",
            };
            return {} as never;
          }),
        write: (input) => Effect.sync(() => void writes.push(input.data)),
      }),
      NodeServices.layer,
    );
    const toolkit = yield* AgentTerminalToolkit.pipe(
      Effect.provide(AgentTerminalToolkitHandlersLive),
    );
    const call = <Name extends keyof typeof AgentTerminalToolkit.tools>(
      name: Name,
      params: Parameters<typeof toolkit.handle<Name>>[1],
    ) =>
      toolkit.handle(name, params).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((chunk) => chunk.at(-1)!.result as Record<string, unknown>),
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provide(services),
      );
    return { call, writes, opened };
  });

describe("agent terminal tools", () => {
  it.effect("external clients cannot start a terminal or read an implicit thread", () =>
    Effect.gen(function* () {
      const { call, writes, opened } = yield* makeHarness("full-access", {
        ...invocation,
        thread: undefined,
        client: { sessionId: "external", label: "External", runtimeModeCeiling: "full-access" },
      });
      expect(yield* call("t3_terminal_start", { name: "dev", command: "pnpm dev" })).toMatchObject({
        code: "capability_denied",
      });
      expect(yield* call("t3_terminal_read", { name: "dev" })).toMatchObject({
        code: "invalid_request",
      });
      expect(writes).toEqual([]);
      expect(opened).toEqual([]);
    }),
  );

  it.effect("starts a command in the thread's workspace, reads it, and interrupts it", () =>
    Effect.gen(function* () {
      const { call, writes, opened } = yield* makeHarness("full-access");

      expect(yield* call("t3_terminal_start", { name: "dev", command: "pnpm dev" })).toEqual({
        terminalId: "agent-dev",
        cwd: "/work/tree",
      });
      expect(writes).toEqual(["pnpm dev\r"]);

      expect(yield* call("t3_terminal_read", { name: "agent-dev" })).toMatchObject({
        state: "running",
        output: "$ pnpm dev\nready",
      });
      expect(
        yield* call("t3_terminal_start", { name: "dev", command: "pnpm dev", cwd: "web" }),
      ).toMatchObject({ code: "invalid_request" });
      expect(opened).toEqual(["/work/tree"]);

      expect(yield* call("t3_terminal_stop", { name: "dev" })).toEqual({
        terminalId: "agent-dev",
        interrupted: true,
        closed: false,
      });
      expect(writes.at(-1)).toBe("\x03");
    }),
  );

  it.effect("refuses to run commands for threads that need approval", () =>
    Effect.gen(function* () {
      const { call, writes } = yield* makeHarness("approval-required");
      expect(yield* call("t3_terminal_start", { name: "dev", command: "pnpm dev" })).toMatchObject({
        code: "capability_denied",
      });
      expect(writes).toEqual([]);
    }),
  );

  it.effect("rejects names outside the agent terminal namespace", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness("full-access");
      expect(yield* call("t3_terminal_read", { name: "My Shell" })).toMatchObject({
        code: "invalid_request",
      });
    }),
  );
});
