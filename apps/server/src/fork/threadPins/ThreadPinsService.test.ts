import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId, type ThreadPinsCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { layerMemory, ThreadPinsService } from "./ThreadPinsService.ts";

const TestLayer = layerMemory.pipe(Layer.provide(NodeServices.layer));

const dispatch = (command: ThreadPinsCommand) =>
  Effect.gen(function* () {
    const pins = yield* ThreadPinsService;
    return yield* pins.dispatch(command);
  });

it.layer(TestLayer)("ThreadPinsService", (it) => {
  it.effect("keeps one note per chat and clears it with blank text", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("note-thread");
      yield* dispatch({ type: "note.set", threadId, text: "Dev server on :4000" });
      const updated = yield* dispatch({
        type: "note.set",
        threadId,
        text: "  Need from you: a) keep v1 API?  ",
      });
      assert.strictEqual(updated.note?.text, "Need from you: a) keep v1 API?");

      const cleared = yield* dispatch({ type: "note.set", threadId, text: "   " });
      assert.isNull(cleared.note);
    }),
  );

  it.effect("renames a re-pinned target, rejects relative paths, and unpins", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pin-thread");
      yield* dispatch({ type: "pin.add", threadId, title: "Guide", target: "/tmp/smoke.md" });
      const renamed = yield* dispatch({
        type: "pin.add",
        threadId,
        title: "Smoke test guide",
        target: "/tmp/smoke.md",
      });
      assert.deepStrictEqual(
        renamed.pins.map((pin) => pin.title),
        ["Smoke test guide"],
      );

      const relative = yield* dispatch({
        type: "pin.add",
        threadId,
        title: "Plan",
        target: "docs/plan.md",
      }).pipe(Effect.flip);
      assert.strictEqual(relative.code, "invalid");

      const withUrl = yield* dispatch({
        type: "pin.add",
        threadId,
        title: "App",
        target: "http://localhost:4000",
      });
      assert.strictEqual(withUrl.pins.length, 2);

      const removed = yield* dispatch({
        type: "pin.remove",
        threadId,
        pinId: withUrl.pins[0]!.id,
      });
      assert.deepStrictEqual(
        removed.pins.map((pin) => pin.target),
        ["http://localhost:4000"],
      );
    }),
  );

  it.effect("streams only the subscribed chat's changes", () =>
    Effect.gen(function* () {
      const pins = yield* ThreadPinsService;
      const watched = ThreadId.make("watched-thread");
      const other = ThreadId.make("other-thread");
      const received = yield* Queue.unbounded<string | null>();
      yield* pins.stream(watched).pipe(
        Stream.runForEach((state) => Queue.offer(received, state.note?.text ?? null)),
        Effect.forkScoped,
      );
      // The first emission comes after the subscription is in place.
      assert.isNull(yield* Queue.take(received));
      yield* dispatch({ type: "note.set", threadId: other, text: "Unrelated" });
      yield* dispatch({ type: "note.set", threadId: watched, text: "Watched" });
      assert.strictEqual(yield* Queue.take(received), "Watched");
    }),
  );
});
