import {
  NodeId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

/** A blocker uses the same durable answer/continue path as an asynchronous question. */
export function humanRequestEvents(
  command: Extract<OrchestrationV2InternalCommand, { type: "thread.request-human" }>,
  now: DateTime.Utc,
  ordinal: number,
) {
  const threadId = command.threadId;
  const requestId = RuntimeRequestId.make(`human:${command.commandId}`);
  const nodeId = NodeId.make(`node:${requestId}`);
  const base = { threadId, nodeId, occurredAt: now };
  return [
    {
      ...base,
      type: "node.updated",
      payload: {
        id: nodeId,
        threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "user_input_request",
        status: "waiting",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: requestId,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    },
    {
      ...base,
      type: "runtime-request.updated",
      payload: {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        blockingReason: command.reason,
        createdAt: now,
        resolvedAt: null,
      },
    },
    {
      ...base,
      type: "turn-item.updated",
      payload: {
        id: TurnItemId.make(`item:${requestId}`),
        threadId,
        runId: null,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "waiting",
        title: "Needs you",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "user_input_request",
        requestId,
        responseMode: "message",
        questions: [
          {
            id: "decision",
            header: "Needs you",
            question: command.reason,
            allowCustomAnswer: true,
            options: [
              {
                label: "Resume",
                value: "The blocker is resolved. Continue from where you stopped.",
                description: "I have resolved the blocker. Continue this chat.",
              },
            ],
          },
        ],
      },
    },
  ] satisfies Array<Omit<OrchestrationV2DomainEvent, "id">>;
}
