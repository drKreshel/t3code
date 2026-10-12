import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { liveThreadsLayer } from "../../mcp/McpToolAccess.testkit.ts";
import * as SidebarFolders from "../sidebarFolders/SidebarFolders.ts";
import { SidebarFoldersToolkitHandlersLive } from "./sidebarFoldersHandlers.ts";
import { SidebarFoldersToolkit } from "./sidebarFoldersTools.ts";

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "session",
  client: undefined,
  thread: {
    threadId: ThreadId.make("thread"),
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const TestLayer = McpToolAccess.HandlersLayer.layer(SidebarFoldersToolkitHandlersLive).pipe(
  Layer.provideMerge(SidebarFolders.layer),
  Layer.provideMerge(liveThreadsLayer),
  Layer.provide(NodeServices.layer),
);

const RegistrationLayer = McpHttpServer.toolkitRegistration(
  SidebarFoldersToolkit,
  SidebarFoldersToolkitHandlersLive,
).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(SidebarFolders.layer),
  Layer.provideMerge(liveThreadsLayer),
  Layer.provide(NodeServices.layer),
);

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "folder-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "folder-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const tools = Effect.gen(function* () {
  const toolkit = yield* SidebarFoldersToolkit;
  return <Name extends keyof typeof SidebarFoldersToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    scope = invocation,
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunks) => chunks.at(-1)!.result),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    );
});

it.effect("lists, deletes, changes icons, settles, and moves through the connected client", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* SidebarFolders.SidebarFolders;
      const server = yield* McpServer.McpServer;
      expect(server.tools.map(({ tool }) => tool.name).toSorted()).toEqual([
        "create_sidebar_folder",
        "delete_sidebar_folder",
        "list_sidebar_folders",
        "move_thread_to_sidebar_folder",
        "set_sidebar_folder_icon",
        "settle_sidebar_folder",
      ]);
      const call = (name: string, args: Record<string, unknown>) =>
        server.callTool({ name, arguments: args }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
          Effect.map((result) => {
            expect(result.isError).toBe(false);
            return result.structuredContent;
          }),
        );
      const connected = yield* Deferred.make<void>();
      yield* service.connect({ clientId: "desktop", label: "Desktop" }).pipe(
        Stream.runForEach((event) => {
          if (event.type === "connected")
            return Deferred.succeed(connected, undefined).pipe(Effect.asVoid);
          return service.respond({
            clientId: "desktop",
            connectionId: event.connectionId,
            requestId: event.requestId,
            result:
              event.action.type === "list"
                ? { type: "listed", folders: [] }
                : event.action.type === "create"
                  ? {
                      type: "folder-created",
                      folderId: "findings",
                      path: event.action.path,
                      createdFolderIds: ["findings"],
                    }
                  : event.action.type === "delete"
                    ? {
                        type: "deleted",
                        deletedFolderIds: [event.action.folderId],
                        releasedThreadCount: 0,
                        queuedTicketFolderClears: 0,
                        queuedTaskFolderClears: 0,
                      }
                    : event.action.type === "set-icon"
                      ? {
                          type: "folder-icon-updated",
                          folderId: event.action.folderId,
                          icon: event.action.icon,
                        }
                      : event.action.type === "set-settled"
                        ? {
                            type: "folder-settled",
                            folderId: event.action.folderId,
                            settled: event.action.settled,
                          }
                        : {
                            type: "thread-moved",
                            thread: event.action.thread,
                            folderId: event.action.folderId,
                          },
          });
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(connected);
      expect(yield* call("list_sidebar_folders", {})).toEqual({
        clients: [{ clientId: "desktop", label: "Desktop", folders: [] }],
        failures: [],
      });
      expect(
        yield* call("create_sidebar_folder", {
          clientId: "desktop",
          path: "t3-code/other-projects-findings",
        }),
      ).toEqual({
        type: "folder-created",
        folderId: "findings",
        path: "t3-code/other-projects-findings",
        createdFolderIds: ["findings"],
      });
      expect(
        yield* call("delete_sidebar_folder", { clientId: "desktop", folderId: "empty" }),
      ).toMatchObject({ type: "deleted", deletedFolderIds: ["empty"] });
      expect(
        yield* call("move_thread_to_sidebar_folder", {
          clientId: "desktop",
          folderId: "scheduled-tasks",
        }),
      ).toEqual({
        type: "thread-moved",
        thread: { environmentId: "environment", threadId: "thread" },
        folderId: "scheduled-tasks",
      });
      expect(
        yield* call("move_thread_to_sidebar_folder", {
          clientId: "desktop",
          threadId: "thread:shared",
          folderId: null,
        }),
      ).toEqual({
        type: "thread-moved",
        thread: { environmentId: "environment", threadId: "thread:shared" },
        folderId: null,
      });
      expect(
        yield* call("set_sidebar_folder_icon", {
          clientId: "desktop",
          folderId: "scheduled-tasks",
          icon: { kind: "image", dataUrl: "data:image/png;base64,aWNvbg==" },
        }),
      ).toEqual({
        type: "folder-icon-updated",
        folderId: "scheduled-tasks",
        icon: { kind: "image", dataUrl: "data:image/png;base64,aWNvbg==" },
      });
      expect(
        yield* call("set_sidebar_folder_icon", {
          clientId: "desktop",
          folderId: "scheduled-tasks",
          icon: null,
        }),
      ).toEqual({
        type: "folder-icon-updated",
        folderId: "scheduled-tasks",
        icon: null,
      });
      expect(
        yield* call("settle_sidebar_folder", {
          clientId: "desktop",
          folderId: "scheduled-tasks",
        }),
      ).toEqual({
        type: "folder-settled",
        folderId: "scheduled-tasks",
        settled: true,
      });
      expect(
        yield* call("settle_sidebar_folder", {
          clientId: "desktop",
          folderId: "scheduled-tasks",
          settled: false,
        }),
      ).toEqual({
        type: "folder-settled",
        folderId: "scheduled-tasks",
        settled: false,
      });
    }),
  ).pipe(Effect.provide(RegistrationLayer)),
);

it.effect("refuses outside callers and read-only MCP clients before folder writes", () =>
  Effect.gen(function* () {
    const call = yield* tools;
    expect(
      yield* call(
        "create_sidebar_folder",
        { clientId: "desktop", path: "t3-code/findings" },
        {
          ...invocation,
          client: { sessionId: "external", label: "External", access: "read-only" },
        },
      ).pipe(Effect.flip),
    ).toMatchObject({ code: "capability_denied" });
    expect(
      yield* call(
        "set_sidebar_folder_icon",
        { clientId: "desktop", folderId: "folder", icon: null },
        {
          ...invocation,
          client: { sessionId: "external", label: "External", access: "read-only" },
        },
      ).pipe(Effect.flip),
    ).toMatchObject({ code: "capability_denied" });
    expect(
      yield* call(
        "delete_sidebar_folder",
        { clientId: "desktop", folderId: "empty" },
        { ...invocation, thread: undefined },
      ).pipe(Effect.flip),
    ).toMatchObject({ code: "thread_credential_required" });
    expect(
      yield* call(
        "delete_sidebar_folder",
        { clientId: "desktop", folderId: "empty" },
        {
          ...invocation,
          client: { sessionId: "external", label: "External", access: "read-only" },
        },
      ).pipe(Effect.flip),
    ).toMatchObject({ code: "capability_denied" });
    expect(
      yield* call(
        "move_thread_to_sidebar_folder",
        { clientId: "desktop", threadId: "thread", folderId: "folder" },
        {
          ...invocation,
          client: { sessionId: "external", label: "External", access: "read-only" },
        },
      ).pipe(Effect.flip),
    ).toMatchObject({ code: "capability_denied" });
    expect(
      yield* call(
        "settle_sidebar_folder",
        { clientId: "desktop", folderId: "folder" },
        {
          ...invocation,
          client: { sessionId: "external", label: "External", access: "read-only" },
        },
      ).pipe(Effect.flip),
    ).toMatchObject({ code: "capability_denied" });
  }).pipe(Effect.provide(TestLayer)),
);
