import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as CodexError from "../errors.ts";

export const JsonRpcId = Schema.Union([Schema.Number, Schema.String]);

const JsonRpcError = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown),
});

export const JsonRpcResponseEnvelope = Schema.Struct({
  id: JsonRpcId,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(JsonRpcError),
});

export const decodeOptionalPayload = <A, I>(
  method: string,
  schema: Schema.Codec<A, I> | undefined,
  raw: unknown,
): Effect.Effect<A, CodexError.CodexAppServerRequestError> => {
  if (!schema) {
    if (raw === undefined) {
      return Effect.sync(() => undefined as A);
    }
    return Effect.fail(
      CodexError.CodexAppServerRequestError.unexpectedPayload(method, "decode-payload", raw),
    );
  }

  return Schema.decodeUnknownEffect(schema)(raw).pipe(
    Effect.mapError((error) =>
      CodexError.CodexAppServerRequestError.invalidPayload(method, "decode-payload", error),
    ),
  );
};

export const encodeOptionalPayload = <A, I>(
  method: string,
  schema: Schema.Codec<A, I> | undefined,
  payload: A,
): Effect.Effect<I | undefined, CodexError.CodexAppServerRequestError> => {
  if (!schema) {
    if (payload === undefined) {
      return Effect.undefined;
    }
    return Effect.fail(
      CodexError.CodexAppServerRequestError.unexpectedPayload(method, "encode-payload", payload),
    );
  }

  return Schema.encodeEffect(schema)(payload).pipe(
    Effect.mapError((error) =>
      CodexError.CodexAppServerRequestError.invalidPayload(method, "encode-payload", error),
    ),
  );
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Codex can add fields to notification items before its pinned protocol schema
 * is refreshed. Keep the native subagent selection that current builds emit so
 * clients do not mistake the child for its parent's model.
 */
function restoreNotificationExtensions<A>(method: string, decoded: A, raw: unknown): A {
  if (method !== "item/started" && method !== "item/completed") return decoded;
  if (!isRecord(decoded) || !isRecord(raw)) return decoded;
  if (!isRecord(decoded.item) || !isRecord(raw.item)) return decoded;
  if (decoded.item.type !== "subAgentActivity" || raw.item.type !== "subAgentActivity") {
    return decoded;
  }

  const model = raw.item.model;
  const reasoningEffort = raw.item.reasoningEffort ?? raw.item.reasoning_effort;
  return {
    ...decoded,
    item: {
      ...decoded.item,
      ...(typeof model === "string" || model === null ? { model } : {}),
      ...(typeof reasoningEffort === "string" || reasoningEffort === null
        ? { reasoningEffort }
        : {}),
    },
  } as A;
}

export const decodeNotificationPayload = <A, I>(
  method: string,
  schema: Schema.Codec<A, I> | undefined,
  raw: unknown,
): Effect.Effect<A, CodexError.CodexAppServerProtocolParseError> => {
  const decoded = schema
    ? Schema.decodeUnknownEffect(schema)(raw).pipe(
        Effect.mapError((error) =>
          CodexError.CodexAppServerRequestError.invalidPayload(method, "decode-payload", error),
        ),
      )
    : decodeOptionalPayload<A, I>(method, schema, raw);

  return decoded.pipe(
    Effect.map((value) => restoreNotificationExtensions(method, value, raw)),
    Effect.mapError((error) =>
      CodexError.CodexAppServerProtocolParseError.fromRequestError(
        "decode-notification-payload",
        method,
        error,
      ),
    ),
  );
};

export const runHandler = Effect.fnUntraced(function* <A, B>(
  handler: ((payload: A) => Effect.Effect<B, CodexError.CodexAppServerError>) | undefined,
  payload: A,
  method: string,
) {
  if (!handler) {
    return yield* CodexError.CodexAppServerRequestError.methodNotFound(method);
  }

  return yield* handler(payload).pipe(
    Effect.mapError((error) =>
      CodexError.CodexAppServerRequestError.fromAppServerError(error, method),
    ),
  );
});
