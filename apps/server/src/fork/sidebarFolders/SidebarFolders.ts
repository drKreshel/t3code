import {
  type SidebarFolderAction,
  type SidebarFolderClient,
  type SidebarFolderReply,
  type SidebarFolderRequestRef,
  type SidebarFolderResult,
  type SidebarFolderListing,
  type SidebarFolderStreamEvent,
  SidebarFoldersError,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/** Routes folder actions to their owning client; folder layouts stay client-local. */
export class SidebarFolders extends Context.Service<
  SidebarFolders,
  {
    readonly list: (clientId?: string) => Effect.Effect<SidebarFolderListing, SidebarFoldersError>;
    readonly connect: (client: SidebarFolderClient) => Stream.Stream<SidebarFolderStreamEvent>;
    readonly delete: (
      clientId: string,
      folderId: string,
    ) => Effect.Effect<Extract<SidebarFolderResult, { type: "deleted" }>, SidebarFoldersError>;
    readonly respond: (reply: SidebarFolderReply) => Effect.Effect<void>;
    readonly claim: (request: SidebarFolderRequestRef) => Effect.Effect<boolean>;
  }
>()("t3/fork/sidebarFolders/SidebarFolders") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const clients = new Map<
    string,
    SidebarFolderClient & {
      connectionId: string;
      queue: Queue.Queue<SidebarFolderStreamEvent, Cause.Done>;
    }
  >();
  const pending = new Map<
    string,
    {
      clientId: string;
      connectionId: string;
      action: SidebarFolderAction;
      claimed: boolean;
      deferred: Deferred.Deferred<SidebarFolderResult, SidebarFoldersError>;
    }
  >();

  const disconnect = Effect.fnUntraced(function* (clientId: string, connectionId: string) {
    const client = clients.get(clientId);
    if (client?.connectionId === connectionId) {
      clients.delete(clientId);
      yield* Queue.end(client.queue);
    }
    for (const [requestId, request] of pending) {
      if (request.clientId !== clientId || request.connectionId !== connectionId) continue;
      pending.delete(requestId);
      yield* Deferred.fail(request.deferred, SidebarFoldersError.fromCode("client-disconnected"));
    }
  });

  const connect: SidebarFolders["Service"]["connect"] = (input) =>
    Stream.unwrap(
      Effect.acquireRelease(
        Effect.gen(function* () {
          const connectionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
          const queue = yield* Queue.dropping<SidebarFolderStreamEvent, Cause.Done>(32);
          const prior = clients.get(input.clientId);
          if (prior) yield* disconnect(prior.clientId, prior.connectionId);
          const client = { ...input, connectionId, queue };
          clients.set(input.clientId, client);
          yield* Queue.offer(queue, { type: "connected", connectionId });
          return client;
        }),
        (client) => disconnect(client.clientId, client.connectionId),
      ).pipe(Effect.map((client) => Stream.fromQueue(client.queue))),
    );

  const invoke = Effect.fn("SidebarFolders.invoke")(function* (
    clientId: string,
    action: SidebarFolderAction,
  ) {
    const requestId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const deferred = yield* Deferred.make<SidebarFolderResult, SidebarFoldersError>();
    const client = clients.get(clientId);
    if (!client) return yield* SidebarFoldersError.fromCode("unavailable");
    pending.set(requestId, {
      clientId,
      connectionId: client.connectionId,
      action,
      deferred,
      claimed: false,
    });
    return yield* Effect.gen(function* () {
      const offered = yield* Queue.offer(client.queue, {
        type: "request",
        connectionId: client.connectionId,
        requestId,
        action,
      });
      if (!offered) return yield* SidebarFoldersError.fromCode("busy");
      const result = yield* Deferred.await(deferred).pipe(Effect.timeoutOption("10 seconds"));
      return Option.isSome(result) ? result.value : yield* SidebarFoldersError.fromCode("timeout");
    }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(requestId))));
  });

  const respond = Effect.fnUntraced(function* (reply: SidebarFolderReply) {
    const request = pending.get(reply.requestId);
    if (
      !request ||
      request.clientId !== reply.clientId ||
      request.connectionId !== reply.connectionId
    )
      return;
    pending.delete(reply.requestId);
    if (reply.error) yield* Deferred.fail(request.deferred, reply.error);
    else if (
      reply.result &&
      reply.result.type === (request.action.type === "list" ? "listed" : "deleted")
    )
      yield* Deferred.succeed(request.deferred, reply.result);
    else yield* Deferred.fail(request.deferred, SidebarFoldersError.fromCode("invalid-response"));
  });

  // Reject queued requests after their MCP invocation ends.
  const claim = (ref: SidebarFolderRequestRef) =>
    Effect.sync(() => {
      const request = pending.get(ref.requestId);
      if (
        !request ||
        request.clientId !== ref.clientId ||
        request.connectionId !== ref.connectionId ||
        request.claimed
      )
        return false;
      request.claimed = true;
      return true;
    });

  const list = Effect.fn("SidebarFolders.list")(function* (clientId?: string) {
    const selected = [...clients.values()].filter(
      (client) => clientId === undefined || client.clientId === clientId,
    );
    if (selected.length === 0) return yield* SidebarFoldersError.fromCode("unavailable");
    const listClient = (client: SidebarFolderClient) =>
      invoke(client.clientId, { type: "list" }).pipe(
        Effect.flatMap((result) =>
          result.type === "listed"
            ? Effect.succeed({
                clientId: client.clientId,
                label: client.label,
                folders: result.folders,
              })
            : Effect.fail(SidebarFoldersError.fromCode("invalid-response")),
        ),
      );
    if (clientId !== undefined) return { clients: [yield* listClient(selected[0]!)], failures: [] };
    const results = yield* Effect.forEach(
      selected,
      (client) =>
        listClient(client).pipe(
          Effect.match({
            onSuccess: (value) => ({ type: "success" as const, value }),
            onFailure: (error) => ({
              type: "failure" as const,
              value: { clientId: client.clientId, label: client.label, error },
            }),
          }),
        ),
      { concurrency: "unbounded" },
    );
    return {
      clients: results.flatMap((result) => (result.type === "success" ? [result.value] : [])),
      failures: results.flatMap((result) => (result.type === "failure" ? [result.value] : [])),
    };
  });

  return SidebarFolders.of({
    list,
    connect,
    delete: (clientId, folderId) =>
      invoke(clientId, { type: "delete", folderId }).pipe(
        Effect.flatMap((result) =>
          result.type === "deleted"
            ? Effect.succeed(result)
            : Effect.fail(SidebarFoldersError.fromCode("invalid-response")),
        ),
      ),
    respond,
    claim,
  });
});

export const layer = Layer.effect(SidebarFolders, make);
