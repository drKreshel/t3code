import { requestGuarded } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  FORK_SIDEBAR_FOLDERS_WS_METHODS,
  type EnvironmentId,
  type SidebarFolderReply,
  type SidebarFolderStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useSidebarFolderStore } from "../sidebarFolderStore";
import { executeSidebarFolderAction } from "../sidebarFolderTools.logic";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "./atomRegistry";

const clientId = randomUUID();

export const sidebarFolderRespond = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "fork:sidebar-folders:respond",
  tag: FORK_SIDEBAR_FOLDERS_WS_METHODS.respond,
  execute: (
    input: SidebarFolderReply & {
      readonly event: Extract<SidebarFolderStreamEvent, { type: "request" }>;
    },
  ) =>
    Effect.gen(function* () {
      const ref = {
        clientId: input.clientId,
        connectionId: input.connectionId,
        requestId: input.requestId,
      };
      const active = yield* requestGuarded(FORK_SIDEBAR_FOLDERS_WS_METHODS.claim, ref);
      if (!active) return;
      const result = executeSidebarFolderAction(
        useSidebarFolderStore.getState(),
        input.event.action,
      );
      yield* requestGuarded(FORK_SIDEBAR_FOLDERS_WS_METHODS.respond, { ...ref, ...result });
    }),
});

export const sidebarFolderClientAtom = Atom.family((environmentId: EnvironmentId) => {
  const connection = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "fork:sidebar-folders:client",
    tag: FORK_SIDEBAR_FOLDERS_WS_METHODS.connect,
    idleTtlMs: 0,
    transform: (stream) =>
      stream.pipe(
        Stream.tap((event) =>
          event.type === "connected"
            ? Effect.void
            : Effect.promise(async () => {
                await sidebarFolderRespond.run(appAtomRegistry, {
                  environmentId,
                  input: {
                    clientId,
                    connectionId: event.connectionId,
                    requestId: event.requestId,
                    event,
                  },
                });
              }),
        ),
      ),
  });
  return connection({
    environmentId,
    input: {
      clientId,
      label: typeof window !== "undefined" && window.desktopBridge ? "Desktop" : "Web",
    },
  });
});
