import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { type SidebarFolderStreamEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SidebarFolders from "./SidebarFolders.ts";

const TestLayer = SidebarFolders.layer.pipe(Layer.provide(NodeServices.layer));
type Request = Extract<SidebarFolderStreamEvent, { type: "request" }>;

const listen = Effect.fnUntraced(function* (
  service: SidebarFolders.SidebarFolders["Service"],
  clientId: string,
  handle: (request: Request) => Effect.Effect<void>,
) {
  const ready = yield* Deferred.make<void>();
  const fiber = yield* service.connect({ clientId, label: clientId }).pipe(
    Stream.runForEach((event) =>
      event.type === "connected" ? Deferred.succeed(ready, undefined) : handle(event),
    ),
    Effect.forkChild,
  );
  yield* Deferred.await(ready);
  return fiber;
});

it.effect(
  "lists each client's independent layout and routes deletion only to the selected client",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* SidebarFolders.SidebarFolders;
        const actions: string[] = [];
        for (const clientId of ["desktop", "web"]) {
          yield* listen(service, clientId, (request) => {
            actions.push(`${clientId}:${request.action.type}`);
            return service.respond({
              clientId,
              connectionId: request.connectionId,
              requestId: request.requestId,
              result:
                request.action.type === "list"
                  ? {
                      type: "listed",
                      folders: [
                        {
                          id: clientId,
                          name: clientId,
                          path: clientId,
                          parentId: null,
                          threadCount: 0,
                          subtreeThreadCount: 0,
                          settled: false,
                          routedTickets: 0,
                          routedTasks: 0,
                        },
                      ],
                    }
                  : {
                      type: "deleted",
                      deletedFolderIds: [request.action.folderId],
                      releasedThreadCount: 0,
                      queuedTicketFolderClears: 0,
                      queuedTaskFolderClears: 0,
                    },
            });
          });
        }
        const listed = yield* service.list();
        expect(listed.clients.map((client) => [client.clientId, client.folders[0]?.id])).toEqual([
          ["desktop", "desktop"],
          ["web", "web"],
        ]);
        yield* service.delete("web", "empty");
        expect(actions.slice(0, 2).toSorted()).toEqual(["desktop:list", "web:list"]);
        expect(actions.slice(2)).toEqual(["web:delete"]);
      }),
    ).pipe(Effect.provide(TestLayer)),
);

it.effect("ignores responses from a different client or stale connection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* SidebarFolders.SidebarFolders;
      yield* listen(service, "desktop", (request) =>
        Effect.gen(function* () {
          const ref = {
            clientId: "desktop",
            connectionId: request.connectionId,
            requestId: request.requestId,
          };
          expect(yield* service.claim({ ...ref, clientId: "other" })).toBe(false);
          expect(yield* service.claim({ ...ref, connectionId: "stale" })).toBe(false);
          expect(yield* service.claim(ref)).toBe(true);
          expect(yield* service.claim(ref)).toBe(false);
          const base = {
            requestId: request.requestId,
            result: { type: "listed" as const, folders: [] },
          };
          yield* service.respond({
            requestId: request.requestId,
            clientId: "other",
            connectionId: request.connectionId,
          });
          yield* service.respond({
            requestId: request.requestId,
            clientId: "desktop",
            connectionId: "stale",
          });
          yield* service.respond({
            ...base,
            clientId: "desktop",
            connectionId: request.connectionId,
          });
        }),
      );
      expect(yield* service.list("desktop")).toEqual({
        clients: [{ clientId: "desktop", label: "desktop", folders: [] }],
        failures: [],
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("fails an in-flight action when its client disconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* SidebarFolders.SidebarFolders;
      const requested = yield* Deferred.make<void>();
      const client = yield* listen(service, "desktop", () =>
        Deferred.succeed(requested, undefined).pipe(Effect.asVoid),
      );
      const action = yield* service.delete("desktop", "empty").pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(requested);
      yield* Fiber.interrupt(client);
      expect((yield* Fiber.join(action)).code).toBe("client-disconnected");
      expect((yield* service.list().pipe(Effect.flip)).code).toBe("unavailable");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("bounds an unresponsive client without claiming the action completed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* SidebarFolders.SidebarFolders;
      const requested = yield* Deferred.make<Request>();
      yield* listen(service, "desktop", (request) =>
        Deferred.succeed(requested, request).pipe(Effect.asVoid),
      );
      const action = yield* service.delete("desktop", "empty").pipe(Effect.flip, Effect.forkChild);
      const request = yield* Deferred.await(requested);
      const ref = {
        clientId: "desktop",
        connectionId: request.connectionId,
        requestId: request.requestId,
      };
      yield* TestClock.adjust("11 seconds");
      expect((yield* Fiber.join(action)).code).toBe("timeout");
      expect(yield* service.claim(ref)).toBe(false);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("rejects a result for the wrong action", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* SidebarFolders.SidebarFolders;
      yield* listen(service, "desktop", (request) =>
        service.respond({
          clientId: "desktop",
          connectionId: request.connectionId,
          requestId: request.requestId,
          result: { type: "listed", folders: [] },
        }),
      );
      expect((yield* service.delete("desktop", "empty").pipe(Effect.flip)).code).toBe(
        "invalid-response",
      );
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps healthy folder listings when another connected client times out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* SidebarFolders.SidebarFolders;
      yield* listen(service, "healthy", (request) =>
        service.respond({
          clientId: "healthy",
          connectionId: request.connectionId,
          requestId: request.requestId,
          result: { type: "listed", folders: [] },
        }),
      );
      const requested = yield* Deferred.make<void>();
      yield* listen(service, "silent", () =>
        Deferred.succeed(requested, undefined).pipe(Effect.asVoid),
      );
      const action = yield* service.list().pipe(Effect.forkChild);
      yield* Deferred.await(requested);
      yield* TestClock.adjust("11 seconds");
      const result = yield* Fiber.join(action);
      expect(result.clients).toEqual([{ clientId: "healthy", label: "healthy", folders: [] }]);
      expect(result.failures).toMatchObject([
        { clientId: "silent", label: "silent", error: { code: "timeout" } },
      ]);
      const targeted = yield* service.list("silent").pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("11 seconds");
      expect((yield* Fiber.join(targeted)).code).toBe("timeout");
    }),
  ).pipe(Effect.provide(TestLayer)),
);
