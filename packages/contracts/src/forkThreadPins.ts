/**
 * Chat pins (fork feature): a short note and a few pinned artifacts that an
 * agent keeps current on its chat, so the user sees them at a glance in the
 * thread details card and on the chat's ticket. They live on the thread's own
 * environment in `fork.sqlite`.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const FORK_THREAD_PINS_WS_METHODS = {
  subscribe: "fork.threadPins.subscribe",
  dispatch: "fork.threadPins.dispatch",
} as const;

export const THREAD_NOTE_MAX_LENGTH = 4000;
export const THREAD_PIN_TITLE_MAX_LENGTH = 200;
export const THREAD_PIN_TARGET_MAX_LENGTH = 4096;
export const THREAD_PINS_MAX = 30;

export const ThreadPin = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  /** An absolute host path or an http(s) URL. */
  target: Schema.String,
  createdAt: IsoDateTime,
});
export type ThreadPin = typeof ThreadPin.Type;

export const ThreadNote = Schema.Struct({
  text: Schema.String,
  updatedAt: IsoDateTime,
});
export type ThreadNote = typeof ThreadNote.Type;

export const ThreadPins = Schema.Struct({
  threadId: ThreadId,
  note: Schema.NullOr(ThreadNote),
  pins: Schema.Array(ThreadPin),
});
export type ThreadPins = typeof ThreadPins.Type;

const command = <Type extends string, Fields extends Schema.Struct.Fields>(
  type: Type,
  fields: Fields,
) => Schema.Struct({ type: Schema.Literal(type), ...fields });

export const ThreadPinsCommand = Schema.Union([
  /** Replaces the note; blank text clears it. */
  command("note.set", {
    threadId: ThreadId,
    text: Schema.String.check(Schema.isMaxLength(THREAD_NOTE_MAX_LENGTH)),
  }),
  /** Pinning a target the chat already pins renames that pin. */
  command("pin.add", {
    threadId: ThreadId,
    title: TrimmedNonEmptyString.check(Schema.isMaxLength(THREAD_PIN_TITLE_MAX_LENGTH)),
    target: TrimmedNonEmptyString.check(Schema.isMaxLength(THREAD_PIN_TARGET_MAX_LENGTH)),
  }),
  command("pin.remove", { threadId: ThreadId, pinId: TrimmedNonEmptyString }),
]);
export type ThreadPinsCommand = typeof ThreadPinsCommand.Type;

export const ThreadPinsErrorCode = Schema.Literals(["not-found", "invalid", "storage"]);
export type ThreadPinsErrorCode = typeof ThreadPinsErrorCode.Type;

export class ThreadPinsError extends Schema.TaggedError<ThreadPinsError>()("ThreadPinsError", {
  code: ThreadPinsErrorCode,
  message: Schema.String,
}) {}

export const ForkThreadPinsSubscribeRpc = Rpc.make(FORK_THREAD_PINS_WS_METHODS.subscribe, {
  payload: Schema.Struct({ threadId: ThreadId }),
  success: ThreadPins,
  error: Schema.Union([ThreadPinsError, EnvironmentAuthorizationError]),
  stream: true,
});

export const ForkThreadPinsDispatchRpc = Rpc.make(FORK_THREAD_PINS_WS_METHODS.dispatch, {
  payload: ThreadPinsCommand,
  success: ThreadPins,
  error: Schema.Union([ThreadPinsError, EnvironmentAuthorizationError]),
});
