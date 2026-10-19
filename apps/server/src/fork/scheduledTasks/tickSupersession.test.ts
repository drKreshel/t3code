import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  RunId,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import { isAutomaticTick, scheduledTaskDispatchIds } from "./tickSupersession.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const taskId = ScheduledTaskId.make("scheduled-task:monitor");
const threadId = ThreadId.make("thread:bound");

const ids = (
  trigger: "scheduled" | "manual" | "webhook",
  firedAtMillis: number,
  id = taskId,
  webhookDeliveryId?: string,
) => scheduledTaskDispatchIds({ taskId: id, firedAtMillis, trigger, webhookDeliveryId }).messageId;

it("recognizes only automatic ticks of the same task", () => {
  const tick = (messageId: MessageId, scheduledTaskId: ScheduledTaskId | null = taskId) =>
    isAutomaticTick(taskId, { id: messageId, scheduledTaskId: scheduledTaskId ?? undefined });
  assert.isTrue(tick(ids("scheduled", 1)));
  assert.isFalse(tick(ids("manual", 1)));
  assert.isFalse(tick(ids("webhook", 1, taskId, "delivery")));
  // A task whose id extends this one's must not be taken for it, in either direction.
  const longer = ScheduledTaskId.make(`${taskId}:2`);
  assert.isFalse(tick(ids("scheduled", 1, longer), longer));
  assert.isFalse(isAutomaticTick(longer, { id: ids("scheduled", 1), scheduledTaskId: taskId }));
  assert.isFalse(tick(ids("scheduled", 1), null));
  assert.isFalse(tick(MessageId.make("user-message")));
});

it.effect(
  "an automatic tick dispatches, then cancels only older waiting ticks of its task; Run now cancels nothing",
  () =>
    Effect.gen(function* () {
      const queued = (ordinal: number, userMessageId: MessageId, status = "queued") => ({
        id: RunId.make(`run:${ordinal}`),
        ordinal,
        userMessageId,
        status,
      });
      const olderTick = queued(3, ids("scheduled", 3));
      const refusedTick = queued(8, ids("scheduled", 8));
      const kept = [
        queued(2, ids("scheduled", 2), "running"),
        queued(4, ids("manual", 4)),
        queued(5, ids("webhook", 5, taskId, "delivery")),
        queued(6, ids("scheduled", 6, ScheduledTaskId.make("scheduled-task:other"))),
        queued(7, MessageId.make("user-message")),
      ];
      const sent = yield* Ref.make<ReadonlyArray<MessageId>>([]);
      // The thread as seen after a dispatch: the runs above plus the one it was accepted as.
      const records = Ref.get(sent).pipe(
        Effect.map((messages) => {
          const runs = [olderTick, ...kept, refusedTick, queued(10, messages.at(-1)!)];
          return {
            runs,
            messages: runs.map((run) => ({
              id: run.userMessageId,
              scheduledTaskId: run.userMessageId.includes("scheduled-task:other")
                ? ScheduledTaskId.make("scheduled-task:other")
                : run.userMessageId.startsWith("scheduled-task-message:")
                  ? taskId
                  : undefined,
            })),
          };
        }),
      );
      const cancelAttempts = yield* Ref.make<ReadonlyArray<RunId>>([]);
      const layerDependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Scheduler.layer,
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          sendToThread: (input) =>
            Ref.update(sent, (all) => [...all, input.messageId]).pipe(
              Effect.as({
                delivery: "queued",
              } as unknown as ThreadManagementService.ThreadManagementSendResult),
            ),
          getThreadRecords: () => records.pipe(Effect.map((value) => value as never)),
          dispatch: (command) =>
            command.type !== "queued-run.cancel"
              ? Effect.die("unexpected command")
              : Ref.update(cancelAttempts, (all) => [...all, command.runId]).pipe(
                  Effect.andThen(
                    command.runId === refusedTick.id
                      ? Effect.fail(
                          new Orchestrator.OrchestratorDispatchError({
                            commandId: command.commandId,
                            commandType: command.type,
                            cause: "refused",
                          }),
                        )
                      : Effect.succeed({ sequence: 1, storedEvents: [] }),
                  ),
                ),
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const { task } = yield* service.upsert(
          yield* decodeUpsertInput({
            id: taskId,
            title: "Monitor",
            prompt: "Check the campaigns.",
            enabled: true,
            schedule: { type: "interval", everyMs: 60_000 },
            projectId: "project:bound",
            threadId,
            workspaceStrategy: { type: "root" },
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
          }),
        );

        const manual = yield* service.runNow({ id: task.id });
        assert.equal(manual.task.lastRunStatus, "succeeded");
        assert.deepEqual(yield* Ref.get(cancelAttempts), []);

        // The tick still dispatches although the last dispatch succeeded and
        // older ticks are waiting: nothing is skipped on dispatch status.
        const ticked = yield* service.subscribeList().pipe(
          Stream.filter(({ tasks }) =>
            tasks.some(
              (candidate) =>
                candidate.id === task.id &&
                candidate.runCount === 2 &&
                candidate.lastRunStatus !== "running",
            ),
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe(manual.task.nextRunAt!)) + 1_000,
        );
        yield* TestClock.adjust("6 seconds");
        yield* Fiber.join(ticked);

        const after = (yield* service.list()).tasks.find((candidate) => candidate.id === task.id)!;
        assert.equal(after.lastRunStatus, "succeeded");
        assert.isNull(after.lastRunError);
        const messages = yield* Ref.get(sent);
        assert.lengthOf(messages, 2);
        assert.isFalse(isAutomaticTick(taskId, { id: messages[0]!, scheduledTaskId: taskId }));
        assert.isTrue(isAutomaticTick(taskId, { id: messages[1]!, scheduledTaskId: taskId }));
        // The refused cancel is logged, not fatal; nothing else is touched.
        assert.deepEqual(yield* Ref.get(cancelAttempts), [olderTick.id, refusedTick.id]);
      }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it("keeps the dispatch ids that tasks have always used", () => {
  assert.deepEqual(
    scheduledTaskDispatchIds({ taskId, firedAtMillis: 1791800104618, trigger: "scheduled" }),
    {
      commandId: CommandId.make(`scheduled-task:${taskId}:1791800104618:scheduled`),
      messageId: MessageId.make(`scheduled-task-message:${taskId}:1791800104618:scheduled`),
    },
  );
  assert.equal(
    scheduledTaskDispatchIds({
      taskId,
      firedAtMillis: 1,
      trigger: "webhook",
      webhookDeliveryId: "delivery",
    }).messageId,
    `scheduled-task-message:${taskId}:webhook:delivery`,
  );
});
