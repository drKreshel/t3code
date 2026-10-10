import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

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

it.effect("lists and deletes through the registered tools and connected client", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* SidebarFolders.SidebarFolders;
      const call = yield* tools;
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
                : {
                    type: "deleted",
                    deletedFolderIds: [event.action.folderId],
                    releasedThreadCount: 0,
                    queuedTicketFolderClears: 0,
                    queuedTaskFolderClears: 0,
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
        yield* call("delete_sidebar_folder", { clientId: "desktop", folderId: "empty" }),
      ).toMatchObject({ type: "deleted", deletedFolderIds: ["empty"] });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses outside callers and read-only MCP clients before deleting", () =>
  Effect.gen(function* () {
    const call = yield* tools;
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
  }).pipe(Effect.provide(TestLayer)),
);
