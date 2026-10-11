import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
// One provider process per thread, like Claude: a workspace change has to release it.
const capabilities = {
  ...CodexProviderCapabilitiesV2,
  sessions: {
    ...CodexProviderCapabilitiesV2.sessions,
    supportsMultipleProviderThreadsPerSession: false,
  },
};

// What `t3_worktree_handoff` does: the agent's own tool call moves the thread to a
// worktree mid-turn and queues the prompt that should continue there.
it.effect(
  "a workspace change ends the running turn and starts the queued one in the worktree",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("workspace-change-detach");
        const worktree = yield* checkpointWorkspace("workspace-change-detach-worktree");
        const opened: Array<{
          readonly cwd: string | null;
          readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
        }> = [];
        const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
        const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
          instanceId,
          driver,
          getCapabilities: () => Effect.succeed(capabilities),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: (input) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
              opened.push({ cwd: input.runtimePolicy.cwd, events });
              return {
                instanceId,
                driver,
                providerSessionId: input.providerSessionId,
                providerSession: {
                  id: input.providerSessionId,
                  driver,
                  providerInstanceId: instanceId,
                  status: "ready",
                  cwd: input.runtimePolicy.cwd ?? cwd,
                  model: modelSelection.model,
                  capabilities,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
                events: Stream.fromQueue(events),
                ensureThread: ({ threadId }) =>
                  Effect.succeed({
                    id: ProviderThreadId.make(`provider-thread:codex:${threadId}`),
                    driver,
                    providerInstanceId: instanceId,
                    providerSessionId: input.providerSessionId,
                    appThreadId: threadId,
                    ownerNodeId: null,
                    nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                    nativeConversationHeadRef: null,
                    status: "idle",
                    firstRunOrdinal: null,
                    lastRunOrdinal: null,
                    handoffIds: [],
                    forkedFrom: null,
                    createdAt: now,
                    updatedAt: now,
                  }),
                resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
                startTurn: (turn) =>
                  Effect.gen(function* () {
                    started.push(turn);
                    yield* Queue.offer(events, {
                      type: "provider_turn.updated",
                      driver,
                      providerTurn: {
                        id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                        providerThreadId: turn.providerThread.id,
                        nodeId: turn.rootNodeId,
                        runAttemptId: turn.attemptId,
                        nativeTurnRef: {
                          driver,
                          nativeId: `native:${turn.attemptId}`,
                          strength: "strong",
                        },
                        ordinal: turn.providerTurnOrdinal,
                        status: "running",
                        startedAt: now,
                        completedAt: null,
                      },
                    });
                  }),
                steerTurn: () => Effect.die("unused"),
                interruptTurn: () => Effect.die("unused"),
                respondToRuntimeRequest: () => Effect.die("unused"),
                readThreadSnapshot: () => Effect.die("unused"),
                rollbackThread: () => Effect.die("unused"),
                forkThread: () => Effect.die("unused"),
              };
            }),
        };
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = ThreadId.make("thread:workspace-change-detach");
          const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
            orchestrator.streamDomainEvents.pipe(
              Stream.filter(predicate),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          const turnRunning = (ordinal: number) =>
            watch(
              (event) =>
                event.type === "provider-turn.updated" &&
                event.payload.status === "running" &&
                event.payload.ordinal === ordinal,
            );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make("project:workspace-change-detach"),
            title: "Workspace change",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const firstRunning = yield* turnRunning(1);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("start"),
            threadId,
            messageId: MessageId.make("message:start"),
            text: "Move this chat into the worktree",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          yield* Fiber.join(firstRunning);
          const first = started[0]!;
          const providerTurnId = ProviderTurnId.make(`provider-turn:${first.attemptId}`);

          // The handoff call is still in flight when it changes the workspace.
          const handoffNodeId = NodeId.make("node:handoff-call");
          const handoffItemId = TurnItemId.make("turn-item:handoff-call");
          const now = yield* DateTime.now;
          const handoffShown = yield* watch(
            (event) => event.type === "turn-item.updated" && event.payload.id === handoffItemId,
          );
          yield* Queue.offerAll(opened[0]!.events, [
            {
              type: "node.updated",
              driver,
              node: {
                id: handoffNodeId,
                threadId,
                runId: first.runId,
                parentNodeId: first.rootNodeId,
                rootNodeId: first.rootNodeId,
                kind: "tool_call",
                status: "running",
                countsForRun: false,
                providerThreadId: first.providerThread.id,
                providerTurnId,
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: null,
              },
            },
            {
              type: "turn_item.updated",
              driver,
              turnItem: {
                id: handoffItemId,
                threadId,
                runId: first.runId,
                nodeId: handoffNodeId,
                providerThreadId: first.providerThread.id,
                providerTurnId,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 101,
                status: "running",
                title: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                type: "dynamic_tool",
                toolName: "mcp__t3-code__t3_worktree_handoff",
                input: { path: worktree },
              },
            },
          ]);
          yield* Fiber.join(handoffShown);

          const firstEnded = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.completedAt !== null,
          );
          const continuationReady = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id !== first.runId &&
              event.payload.status === "starting",
          );
          const continuationRunning = yield* turnRunning(2);
          yield* orchestrator.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("handoff"),
            threadId,
            branch: "feature/worktree",
            worktreePath: worktree,
            expectedWorktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("continuation"),
            threadId,
            messageId: MessageId.make("message:continuation"),
            text: "Continue in the worktree",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "mcp",
          });
          yield* worker.drain();
          yield* Fiber.join(firstEnded);
          // The turn was ended on purpose, so it is not a provider error. A failed
          // run would also hold the queue, and the continuation would never start.
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
            "cancelled",
          );
          yield* Fiber.join(continuationReady);
          yield* worker.drain();
          yield* Fiber.join(continuationRunning);

          const projection = yield* orchestrator.getThreadProjection(threadId);
          const continuation = projection.runs[1];
          assert.isEmpty(projection.turnItems.filter((item) => item.type === "error"));
          // Nothing is left for the composer to report as running in the background.
          assert.equal(
            projection.turnItems.find((item) => item.id === handoffItemId)?.status,
            "cancelled",
          );
          assert.equal(
            projection.nodes.find((node) => node.id === handoffNodeId)?.status,
            "cancelled",
          );
          // The queued prompt ran on its own, in the worktree.
          assert.equal(continuation?.status, "running");
          assert.deepEqual(
            opened.map((session) => session.cwd),
            [cwd, worktree],
          );
          assert.equal(started[1]?.message.text, "Continue in the worktree");
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "workspace-change-detach" },
              ProviderAdapterRegistry.layerSingle(adapter),
              { runEffectWorker: false },
            ),
          ),
        );
      }),
    ),
);
