/**
 * The automation engine against the real orchestration engine and projections
 * (in-memory SQLite), so the commands it dispatches must pass the real decider.
 * Only settings, git, and the environment id are stubbed; no provider runs, so
 * a started turn stops at `thread.turn-start-requested`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
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

import { ServerConfig } from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { BoardsService, layerMemory as boardsLayerMemory } from "../boards/BoardsService.ts";
import { AutomationEngine, layerManual } from "./AutomationEngine.ts";
import { layerMemory as storeLayerMemory } from "./AutomationsStore.ts";

const ENVIRONMENT_ID = EnvironmentId.make("env-real");
const PROJECT_ID = ProjectId.make("project-real");

const action: AutomationAction = {
  projectKey: null,
  modelSelection: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  checkout: "local",
};

const OrchestrationLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-automation-orchestration-" }),
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
  it.effect("a board hook creates a real chat whose first turn is requested", () =>
    Effect.gen(function* () {
      const orchestration = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const boards = yield* BoardsService;
      const engine = yield* AutomationEngine.pipe(Effect.provide(layerManual));

      yield* orchestration.dispatch({
        type: "project.create",
        commandId: CommandId.make("fork-real-project"),
        projectId: PROJECT_ID,
        title: "Atlas",
        workspaceRoot: "/tmp/fork-real-atlas",
        createdAt: DateTime.formatIso(yield* DateTime.now),
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
      const active = columns.find((column) => column.type === "active")!.id;
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

      const readModel = yield* snapshots.getSnapshot();
      const thread = readModel.threads.find((candidate) => candidate.title.startsWith("ATLAS-1"));
      expect(thread?.title).toBe("ATLAS-1 · Implement");
      expect(thread?.projectId).toBe(PROJECT_ID);
      expect(thread?.messages.map((message) => [message.role, message.text])).toEqual([
        ["user", "Implement ATLAS-1: Meter notes"],
      ]);

      const events = yield* Stream.runCollect(orchestration.readEvents(0));
      const threadEvents = Array.from(events)
        .filter((event) => "threadId" in event.payload && event.payload.threadId === thread!.id)
        .map((event) => event.type);
      expect(threadEvents).toEqual(
        expect.arrayContaining([
          "thread.created",
          "thread.message-sent",
          "thread.turn-start-requested",
        ]),
      );

      const ticket = (yield* boards.snapshot).tickets.find((entry) => entry.id === ticketId)!;
      expect(ticket.threadKeys).toEqual([`${ENVIRONMENT_ID}:${thread!.id}`]);
    }).pipe(Effect.provide(TestLayer)),
  );
});
