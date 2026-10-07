import { type ThreadPins, type ThreadPinsCommand, ThreadPinsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { ThreadPinsService } from "../threadPins/ThreadPinsService.ts";
import { ThreadPinsToolkit } from "./pinsTools.ts";

const failure = (code: ThreadPinsError["code"], message: string) =>
  new ThreadPinsError({ code, message });

const toResult = (pins: ThreadPins) => ({
  pins: pins.pins.map(({ id, title, target }) => ({ id, title, target })),
});

const make = Effect.gen(function* () {
  // Optional like the WebSocket handlers, so runtimes without fork services still build.
  const service = yield* Effect.serviceOption(ThreadPinsService);

  /** The calling chat: pins always belong to the agent's own thread. */
  const callerThreadId = McpInvocationContext.McpInvocationContext.pipe(
    Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "Chat pins")),
    Effect.mapError(() => failure("invalid", "Chat pins require an agent running in a T3 thread.")),
    Effect.map((scope) => scope.thread.threadId),
  );

  const withService = <A>(
    use: (pins: ThreadPinsService["Service"]) => Effect.Effect<A, ThreadPinsError>,
  ) =>
    Option.match(service, {
      onNone: () => Effect.fail(failure("storage", "Chat pins are not available on this server.")),
      onSome: use,
    });

  const dispatch = (command: ThreadPinsCommand) =>
    withService((pins) => pins.dispatch(command).pipe(Effect.map(toResult)));

  return {
    pin_note: McpToolAccess.actsAsCaller(({ title, text }) =>
      Effect.flatMap(callerThreadId, (threadId) =>
        dispatch({ type: "note.set", threadId, title, text }),
      ),
    ),
    pin_artifact: McpToolAccess.actsAsCaller(({ title, target }) =>
      Effect.flatMap(callerThreadId, (threadId) =>
        dispatch({ type: "pin.add", threadId, title, target }),
      ),
    ),
    unpin_artifact: McpToolAccess.actsAsCaller(({ pin }) =>
      Effect.gen(function* () {
        const threadId = yield* callerThreadId;
        const current = yield* withService((pins) => pins.get(threadId));
        const match =
          current.pins.find((entry) => entry.id === pin || entry.target === pin) ??
          current.pins.find((entry) => entry.text !== null && entry.title === pin);
        if (match === undefined)
          return yield* failure(
            "not-found",
            "This chat has no pin with that id, target, or title.",
          );
        return yield* dispatch({ type: "pin.remove", threadId, pinId: match.id });
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof ThreadPinsToolkit.tools>;
});

export const ThreadPinsToolkitHandlersLive = McpToolAccess.toLayer(ThreadPinsToolkit, make);
