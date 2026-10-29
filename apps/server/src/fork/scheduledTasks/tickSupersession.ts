/**
 * Fork: a scheduled task's automatic tick that is still waiting in its chat's
 * queue is obsolete once a newer tick of the same task is accepted. Without
 * this, a tick queued behind long work, or held by a restart, runs hours later
 * with a stale prompt while newer ticks have already run.
 */
import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ScheduledTaskId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";

export type ScheduledTaskTrigger = "scheduled" | "manual" | "webhook";

const MESSAGE_PREFIX = "scheduled-task-message:";

/**
 * Ids for one scheduler dispatch. Ticks and Run now are keyed by fire time and
 * trigger; a webhook dispatch by its delivery, so a delivery never runs twice.
 * `isAutomaticTick` recognizes ticks by this format, so both live here.
 */
export function scheduledTaskDispatchIds(input: {
  readonly taskId: ScheduledTaskId;
  readonly firedAtMillis: number;
  readonly trigger: ScheduledTaskTrigger;
  readonly webhookDeliveryId?: string | undefined;
}) {
  const fireKey =
    input.webhookDeliveryId === undefined
      ? `${input.taskId}:${input.firedAtMillis}:${input.trigger}`
      : `${input.taskId}:webhook:${input.webhookDeliveryId}`;
  return {
    commandId: CommandId.make(`scheduled-task:${fireKey}`),
    messageId: MessageId.make(`${MESSAGE_PREFIX}${fireKey}`),
  };
}

/** Run now, webhook deliveries and other tasks' ticks are never automatic ticks of `taskId`. */
export function isAutomaticTick(
  taskId: ScheduledTaskId,
  message: { readonly id: string; readonly scheduledTaskId?: ScheduledTaskId | undefined },
): boolean {
  const prefix = `${MESSAGE_PREFIX}${taskId}:`;
  return (
    message.scheduledTaskId === taskId &&
    message.id.startsWith(prefix) &&
    /^\d+:scheduled$/u.test(message.id.slice(prefix.length))
  );
}

/**
 * Older automatic ticks of the task that have not started. Held runs are
 * included: cancelling one ends it without releasing the hold on the rest.
 */
function supersededTickRuns(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  taskId: ScheduledTaskId,
  accepted: Pick<OrchestrationV2Run, "id" | "ordinal">,
): ReadonlyArray<OrchestrationV2Run> {
  const ticks = new Set(
    projection.messages
      .filter((message) => isAutomaticTick(taskId, message))
      .map((message) => message.id),
  );
  return projection.runs.filter(
    (run) =>
      run.status === "queued" &&
      run.id !== accepted.id &&
      run.ordinal < accepted.ordinal &&
      ticks.has(run.userMessageId),
  );
}

/**
 * Cancels the ticks superseded by the run of `acceptedMessageId`, with the
 * queue's own cancel command. Never fails: a run that started or ended
 * meanwhile needs nothing, and any other failure only leaves an old tick
 * waiting, which must not fail the new tick.
 */
export const cancelSupersededTicks = Effect.fn("ScheduledTasks.cancelSupersededTicks")(
  function* (
    threads: ThreadManagementService.ThreadManagementService["Service"],
    input: {
      readonly threadId: ThreadId;
      readonly taskId: ScheduledTaskId;
      readonly acceptedMessageId: MessageId;
      readonly commandId: CommandId;
    },
  ) {
    const records = yield* threads.getThreadRecords(input.threadId, ["runs", "messages"], {
      messageRoles: ["user"],
    });
    const accepted = records.runs.find((run) => run.userMessageId === input.acceptedMessageId);
    if (accepted === undefined) return;
    for (const run of supersededTickRuns(records, input.taskId, accepted)) {
      yield* threads
        .dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make(`${input.commandId}:supersede:${run.id}`),
          threadId: input.threadId,
          runId: run.id,
        })
        .pipe(
          Effect.catchCause((cause) =>
            threads.getThreadRecords(input.threadId, ["runs"], { runIds: [run.id] }).pipe(
              Effect.flatMap(({ runs }) =>
                runs.some((candidate) => candidate.id === run.id && candidate.status === "queued")
                  ? Effect.logWarning("Could not cancel a superseded scheduled tick", {
                      taskId: input.taskId,
                      runId: run.id,
                      cause,
                    })
                  : Effect.void,
              ),
            ),
          ),
        );
    }
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Could not check for superseded scheduled ticks", { cause }),
  ),
);
