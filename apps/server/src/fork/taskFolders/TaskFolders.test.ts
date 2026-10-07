import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  type ScheduledTask,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { ScheduledTaskService } from "../../scheduledTasks/ScheduledTaskService.ts";
import { TaskFolders, layerMemory } from "./TaskFolders.ts";

const BLOG = ScheduledTaskId.make("blog");
const run = (messageId: string, threadId: string, startedAt: string) => ({
  messageId: MessageId.make(messageId),
  taskId: BLOG,
  threadId: ThreadId.make(threadId),
  projectId: ProjectId.make("project-1"),
  threadTitle: "Blog draft",
  startedAt,
  finishedAt: null,
  state: "succeeded" as const,
});

const TestLayer = layerMemory.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ScheduledTaskService)({
        list: () => Effect.succeed({ tasks: [{ id: BLOG } as ScheduledTask] }),
        subscribeList: () => Stream.make({ tasks: [] }),
        listRuns: () =>
          Effect.succeed({
            runs: [
              run("m-2", "chat-2", "2026-10-02T06:00:00.000Z"),
              run("m-1", "chat-1", "2026-10-01T06:00:00.000Z"),
            ],
          }),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("env-1")),
      }),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

describe("TaskFolders", () => {
  it.effect(
    "pairs a task's folder with its runs' chats, oldest first, and forgets it on null",
    () =>
      Effect.gen(function* () {
        const folders = yield* TaskFolders;
        const first = yield* folders.stream.pipe(Stream.take(1), Stream.runHead);
        expect(first._tag === "Some" ? first.value.routes : null).toEqual([]);

        yield* folders.set({ taskId: BLOG, folder: "Scheduled/Blog" });
        // A task that no longer exists keeps its row but gets no route.
        yield* folders.set({ taskId: ScheduledTaskId.make("deleted"), folder: "Old" });
        const filed = yield* folders.stream.pipe(Stream.take(1), Stream.runHead);
        expect(filed._tag === "Some" ? filed.value.routes : null).toEqual([
          { taskId: BLOG, folder: "Scheduled/Blog", threadKeys: ["env-1:chat-1", "env-1:chat-2"] },
        ]);

        yield* folders.set({ taskId: BLOG, folder: null });
        const cleared = yield* folders.stream.pipe(Stream.take(1), Stream.runHead);
        expect(cleared._tag === "Some" ? cleared.value.routes : null).toEqual([]);
      }).pipe(Effect.provide(TestLayer)),
  );
});
