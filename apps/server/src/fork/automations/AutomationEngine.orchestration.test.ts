/**
 * The automation engine against the real orchestration engine and projections
 * (in-memory SQLite), so the commands it dispatches must pass the real decider.
 * Only settings, git, the environment id, and provider capabilities are stubbed.
 * The effect worker stays stopped, so no provider process runs.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  CommandId,
  ProviderInstanceId,
  ProviderDriverKind,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type AutomationAction,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ProjectStoreV2, layer as projectStoreLayer } from "../../orchestration-v2/ProjectStore.ts";
import { EventStoreV2, layer as eventStoreLayer } from "../../orchestration-v2/EventStore.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeLayer as registryLayer } from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "../../orchestration-v2/ProviderAdapter.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { BoardsService, layerMemory as boardsLayerMemory } from "../boards/BoardsService.ts";
import { AutomationEngine, layerManual } from "./AutomationEngine.ts";
import { AutomationsStore, layerMemory as storeLayerMemory } from "./AutomationsStore.ts";

const ENVIRONMENT_ID = EnvironmentId.make("env-real");
const PROJECT_ID = ProjectId.make("project-real");

const action: AutomationAction = {
  projectKey: null,
  modelSelection: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  checkout: "local",
};

const database = SqlitePersistenceMemory;
const adapter = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("This test does not start a provider process"),
} as ProviderAdapterV2Shape;
const OrchestrationLayer = Layer.mergeAll(
  projectStoreLayer.pipe(Layer.provide(database)),
  eventStoreLayer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry({ name: "fork-automation" }, registryLayer([adapter]), {
    databaseLayer: database,
    runEffectWorker: false,
  }),
);

const Stubs = Layer.mergeAll(
  Layer.mock(ServerSettings.ServerSettingsService)({
    getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
  }),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ServerEnvironment.ServerEnvironment)({
    getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
  }),
);

const TestLayer = Layer.mergeAll(
  OrchestrationLayer,
  boardsLayerMemory,
  storeLayerMemory,
  Stubs,
).pipe(Layer.provideMerge(NodeServices.layer));

describe("AutomationEngine with real orchestration", () => {
  it.effect("a board hook starts a v2 chat and records an interrupted run on its ticket", () =>
    Effect.gen(function* () {
      const orchestration = yield* OrchestratorV2;
      const projects = yield* ProjectStoreV2;
      const eventStore = yield* EventStoreV2;
      const boards = yield* BoardsService;
      const engine = yield* AutomationEngine.pipe(Effect.provide(layerManual));

      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* projects.apply({
        sequence: 1,
        eventId: EventId.make("fork-real-project"),
        aggregateKind: "project",
        aggregateId: PROJECT_ID,
        occurredAt: createdAt,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId: PROJECT_ID,
          title: "Atlas",
          workspaceRoot: "/tmp/fork-real-atlas",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });

      const boardId = (yield* boards.dispatch(
        {
          type: "board.create",
          name: "Atlas",
          key: "ATLAS",
          defaultProjectKey: `${ENVIRONMENT_ID}:${PROJECT_ID}`,
        },
        "user",
      )).id!;
      const columns = (yield* boards.snapshot).boards[0]!.columns;
      const active = columns.find((column) => column.name === "In progress")!.id;
      yield* engine.dispatch({
        type: "automation.create",
        title: "Implement",
        prompt: "Implement {{ticket.key}}: {{ticket.title}}",
        trigger: { type: "board", boardId, columnId: active },
        action,
        maxRunsPerTicket: 3,
      });
      const ticketId = (yield* boards.dispatch(
        { type: "ticket.create", boardId, title: "Meter notes" },
        "user",
      )).id!;

      // Move the ticket and hand the board events to the engine, as the server does.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* boards.subscribeEvents;
          yield* boards.dispatch({ type: "ticket.move", ticketId, columnId: active }, "user");
          const queued = yield* PubSub.remaining(subscription);
          const emitted = queued > 0 ? yield* PubSub.takeUpTo(subscription, queued) : [];
          for (const event of emitted) yield* engine.handleBoardEvent(event);
        }),
      );

      const readModel = yield* orchestration.getShellSnapshot();
      const thread = readModel.threads.find((candidate) => candidate.title.startsWith("ATLAS-1"));
      expect(thread?.title).toBe("ATLAS-1 · Implement");
      expect(thread?.projectId).toBe(PROJECT_ID);
      const records = yield* orchestration.getThreadRecords(thread!.id, ["messages", "runs"]);
      expect(records.messages.map((message) => [message.role, message.text])).toEqual([
        ["user", "Implement ATLAS-1: Meter notes"],
      ]);

      const events = yield* Stream.runCollect(eventStore.read({ threadId: thread!.id }));
      const threadEvents = Array.from(events).map((stored) => stored.event.type);
      expect(threadEvents).toEqual(
        expect.arrayContaining(["thread.created", "message.updated", "run.created"]),
      );

      const ticket = (yield* boards.snapshot).tickets.find((entry) => entry.id === ticketId)!;
      expect(ticket.threadKeys).toEqual([`${ENVIRONMENT_ID}:${thread!.id}`]);
      const interrupted = yield* orchestration.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("stop-fork-automation"),
        threadId: thread!.id,
        runId: records.runs[0]!.id,
      });
      for (const stored of interrupted.storedEvents) yield* engine.handleDomainEvent(stored.event);
      const store = yield* AutomationsStore;
      expect((yield* store.snapshot).runs[0]).toMatchObject({
        status: "failed",
        reason: "The chat was stopped.",
      });
      expect((yield* boards.snapshot).tickets[0]!.flag).toMatchObject({ level: "error" });
    }).pipe(Effect.provide(TestLayer)),
  );
});
