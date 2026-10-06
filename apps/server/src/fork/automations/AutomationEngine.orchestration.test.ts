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
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ProjectStoreV2, layer as projectStoreLayer } from "../../orchestration-v2/ProjectStore.ts";
import { EventStoreV2, layer as eventStoreLayer } from "../../orchestration-v2/EventStore.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "../../orchestration-v2/ProviderAdapter.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { layerMemory as boardsLayerMemory } from "../boards/BoardsService.ts";
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

const database = SqlitePersistence.layerMemory;
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
  ProviderReplayHarness.layerWithRegistry(
    { name: "fork-automation" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    {
      databaseLayer: database,
      runEffectWorker: false,
    },
  ),
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
  it.effect("a scheduled run starts a v2 chat in its project and records an interrupted turn", () =>
    Effect.gen(function* () {
      const orchestration = yield* OrchestratorV2;
      const projects = yield* ProjectStoreV2;
      const eventStore = yield* EventStoreV2;
      const store = yield* AutomationsStore;
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

      const automationId = (yield* engine.dispatch({
        type: "automation.create",
        title: "Nightly audit",
        prompt: "Audit the dependencies.",
        trigger: {
          type: "schedule",
          schedule: { kind: "cron", cron: "0 2 * * *" },
          timezone: "UTC",
        },
        action: { ...action, projectKey: `${ENVIRONMENT_ID}:${PROJECT_ID}` },
      })).id!;
      expect((yield* orchestration.getShellSnapshot()).threads).toHaveLength(0);

      yield* engine.dispatch({ type: "automation.runNow", automationId });
      const threads = (yield* orchestration.getShellSnapshot()).threads;
      expect(threads).toHaveLength(1);
      const thread = threads[0]!;
      expect(thread.title).toBe("Nightly audit");
      expect(thread.projectId).toBe(PROJECT_ID);
      const records = yield* orchestration.getThreadRecords(thread.id, ["messages", "runs"]);
      expect(records.messages.map((message) => message.text)).toEqual(["Audit the dependencies."]);

      const events = yield* Stream.runCollect(eventStore.read({ threadId: thread.id }));
      expect(Array.from(events).map((stored) => stored.event.type)).toEqual(
        expect.arrayContaining(["thread.created", "message.updated", "run.created"]),
      );
      expect((yield* store.snapshot).runs[0]).toMatchObject({
        status: "running",
        threadKey: `${ENVIRONMENT_ID}:${thread.id}`,
      });

      const interrupted = yield* orchestration.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("stop-fork-automation"),
        threadId: thread.id,
        runId: records.runs[0]!.id,
      });
      for (const stored of interrupted.storedEvents) yield* engine.handleDomainEvent(stored.event);
      expect((yield* store.snapshot).runs[0]).toMatchObject({
        status: "failed",
        reason: "The chat was stopped.",
      });
    }).pipe(Effect.provide(TestLayer)),
  );
});
