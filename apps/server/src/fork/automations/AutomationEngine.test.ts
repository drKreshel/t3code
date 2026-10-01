import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type AutomationAction,
  type BoardsSnapshot,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { BoardsService, layerMemory as boardsLayerMemory } from "../boards/BoardsService.ts";
import { AutomationEngine, layerManual } from "./AutomationEngine.ts";
import { AutomationsStore, layerMemory as storeLayerMemory } from "./AutomationsStore.ts";

const ENVIRONMENT_ID = EnvironmentId.make("env-1");
const PROJECT_ID = ProjectId.make("project-1");
const PROJECT_KEY = `${ENVIRONMENT_ID}:${PROJECT_ID}`;

const action: AutomationAction = {
  projectKey: null,
  modelSelection: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  checkout: "local",
};

type TurnState = "running" | "completed" | "error" | "interrupted";

/**
 * Engine over in-memory boards and automations, with orchestration faked:
 * dispatched commands are recorded, and each chat's turn state is set by the test.
 */
const makeHarness = Effect.gen(function* () {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const turnStates = yield* Ref.make<ReadonlyMap<string, TurnState>>(new Map());
  const project = {
    id: PROJECT_ID,
    title: "Atlas",
    workspaceRoot: "/work/atlas",
  } as OrchestrationProjectShell;

  const fakes = Layer.mergeAll(
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Ref.update(commands, (list) => [...list, command]).pipe(Effect.as({ sequence: 1 })),
      subscribeDomainEvents: Effect.succeed(Stream.empty),
      streamDomainEvents: Stream.empty,
      readEvents: () => Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getProjectShellById: (projectId) =>
        Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
      getThreadShellById: (threadId) =>
        Ref.get(turnStates).pipe(
          Effect.map((states) => {
            const state = states.get(threadId);
            return state === undefined
              ? Option.none()
              : Option.some({
                  id: threadId,
                  latestTurn: { state },
                  session: null,
                } as unknown as OrchestrationThreadShell);
          }),
        ),
    }),
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    }),
    Layer.mock(GitWorkflowService.GitWorkflowService)({
      createWorktree: () =>
        Effect.succeed({
          worktree: { refName: "t3code/abcd1234", path: "/work/worktrees/abcd1234" },
        } as never),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
    }),
  );

  const engine = yield* AutomationEngine.pipe(
    Effect.provide(layerManual.pipe(Layer.provide(fakes))),
  );
  const boards = yield* BoardsService;
  const store = yield* AutomationsStore;

  const threadIdsStarted = Ref.get(commands).pipe(
    Effect.map((list) =>
      list.flatMap((command) => (command.type === "thread.create" ? [command.threadId] : [])),
    ),
  );

  /** Ends a chat's turn the way orchestration reports it. */
  const endTurn = (threadId: ThreadId, state: TurnState) =>
    Effect.gen(function* () {
      yield* Ref.update(turnStates, (states) => new Map(states).set(threadId, state));
      yield* engine.handleDomainEvent({
        type: "thread.session-set",
        payload: { threadId, session: { status: state === "error" ? "error" : "ready" } },
      } as unknown as OrchestrationEvent);
    });

  /** Dispatches a board command as `actor` and feeds the events it causes to the engine. */
  const boardDispatch = (command: Parameters<typeof boards.dispatch>[0], actor = "user") =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* boards.subscribeEvents;
        const result = yield* boards.dispatch(command, actor);
        // Events are published before dispatch returns, so they are all queued here.
        const queued = yield* PubSub.remaining(subscription);
        const emitted = queued > 0 ? yield* PubSub.takeUpTo(subscription, queued) : [];
        for (const event of emitted) yield* engine.handleBoardEvent(event);
        return result;
      }),
    );

  return { engine, boards, store, commands, threadIdsStarted, endTurn, boardDispatch };
});

const TestLayer = Layer.mergeAll(boardsLayerMemory, storeLayerMemory).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const setupBoard = (harness: Effect.Success<typeof makeHarness>) =>
  Effect.gen(function* () {
    const boardId = (yield* harness.boards.dispatch(
      { type: "board.create", name: "Atlas", key: "ATLAS", defaultProjectKey: PROJECT_KEY },
      "user",
    )).id!;
    const snapshot: BoardsSnapshot = yield* harness.boards.snapshot;
    const column = (name: string) =>
      snapshot.boards[0]!.columns.find((candidate) => candidate.name === name)!.id;
    const hookId = (yield* harness.engine.dispatch({
      type: "automation.create",
      title: "Implement",
      prompt: "Implement {{ticket.key}}: {{ticket.title}}",
      trigger: { type: "board", boardId, columnId: column("In progress") },
      action,
      maxRunsPerTicket: 2,
    })).id!;
    const ticket = (title: string, requires?: string[]) =>
      harness.boards
        .dispatch(
          { type: "ticket.create", boardId, title, ...(requires ? { requires } : {}) },
          "user",
        )
        .pipe(Effect.map((result) => result.id!));
    return { boardId, column, hookId, ticket };
  });

describe("AutomationEngine", () => {
  it.effect(
    "starts a linked chat with the rendered prompt when a ticket enters a hooked column",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const { column, ticket } = yield* setupBoard(harness);
        const ticketId = yield* ticket("Meter notes");
        yield* harness.boardDispatch({
          type: "ticket.move",
          ticketId,
          columnId: column("In progress"),
        });

        const commands = yield* Ref.get(harness.commands);
        expect(commands.map((command) => command.type)).toEqual([
          "thread.create",
          "thread.turn.start",
        ]);
        const turn = commands[1]!;
        expect(turn.type === "thread.turn.start" && turn.message.text).toBe(
          "Implement ATLAS-1: Meter notes",
        );
        const [threadId] = yield* harness.threadIdsStarted;
        const linked = (yield* harness.boards.snapshot).tickets[0]!.threadKeys;
        expect(linked).toEqual([`${ENVIRONMENT_ID}:${threadId}`]);
        const runs = (yield* harness.store.snapshot).runs;
        expect(runs.map((run) => run.status)).toEqual(["running"]);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("queues a second trigger behind the live chat and starts it when that chat ends", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { column, ticket } = yield* setupBoard(harness);
      const ticketId = yield* ticket("Meter notes");
      yield* harness.boardDispatch({ type: "ticket.move", ticketId, columnId: column("Todo") });
      yield* harness.boardDispatch(
        { type: "ticket.move", ticketId, columnId: column("In progress") },
        "automation:other",
      );
      // Re-entering while the first chat still runs queues one run.
      yield* harness.boardDispatch(
        { type: "ticket.move", ticketId, columnId: column("Todo") },
        "agent",
      );
      yield* harness.boardDispatch(
        { type: "ticket.move", ticketId, columnId: column("In progress") },
        "agent",
      );
      expect((yield* harness.threadIdsStarted).length).toBe(1);
      expect((yield* harness.store.snapshot).runs.map((run) => run.status).toSorted()).toEqual([
        "queued",
        "running",
      ]);

      const [first] = yield* harness.threadIdsStarted;
      yield* harness.endTurn(first!, "completed");
      expect((yield* harness.threadIdsStarted).length).toBe(2);
      const statuses = (yield* harness.store.snapshot).runs.map((run) => run.status).toSorted();
      expect(statuses).toEqual(["running", "succeeded"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("stops at the run limit and flags the ticket where it stands", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { column, ticket } = yield* setupBoard(harness);
      const ticketId = yield* ticket("Flaky");
      // Two runs that end without the ticket moving on: the agent bounces it back.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        yield* harness.boardDispatch(
          { type: "ticket.move", ticketId, columnId: column("In progress") },
          "agent",
        );
        yield* harness.endTurn((yield* harness.threadIdsStarted).at(-1)!, "completed");
        yield* harness.boardDispatch(
          { type: "ticket.move", ticketId, columnId: column("Review") },
          "agent",
        );
      }
      // The third entry hits the limit of 2.
      yield* harness.boardDispatch(
        { type: "ticket.move", ticketId, columnId: column("In progress") },
        "agent",
      );
      expect((yield* harness.threadIdsStarted).length).toBe(2);
      const current = (yield* harness.boards.snapshot).tickets[0]!;
      expect(current.columnId).toBe(column("In progress"));
      expect(current.flag).toMatchObject({ level: "warning" });
      expect(current.flag?.reason).toMatch(/ran 2 times/);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("waits for a blocked ticket and fires once it is unblocked", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { column, ticket } = yield* setupBoard(harness);
      const schema = yield* ticket("Schema");
      const endpoint = yield* ticket("Endpoint", [schema]);
      // A blocked ticket moves freely; its hook waits until it is unblocked.
      yield* harness.boardDispatch({
        type: "ticket.move",
        ticketId: endpoint,
        columnId: column("In progress"),
      });
      expect((yield* harness.threadIdsStarted).length).toBe(0);
      yield* harness.boardDispatch({ type: "ticket.setStatus", ticketId: schema, status: "done" });
      expect((yield* harness.threadIdsStarted).length).toBe(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("escalates a failed chat with its reason", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { column, ticket } = yield* setupBoard(harness);
      const ticketId = yield* ticket("Crashy");
      yield* harness.boardDispatch({
        type: "ticket.move",
        ticketId,
        columnId: column("In progress"),
      });
      const [threadId] = yield* harness.threadIdsStarted;
      yield* harness.endTurn(threadId!, "error");
      const current = (yield* harness.boards.snapshot).tickets[0]!;
      expect(current.flag).toMatchObject({ level: "error" });
      expect(current.flag?.reason).toMatch(/"Implement" failed/);
      expect((yield* harness.store.snapshot).runs[0]!.status).toBe("failed");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("runs a schedule on demand in its project, without a ticket", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const id = (yield* harness.engine.dispatch({
        type: "automation.create",
        title: "Weekly audit",
        prompt: "Audit the repo (run {{run.number}})",
        trigger: {
          type: "schedule",
          schedule: { kind: "cron", cron: "0 9 * * 1" },
          timezone: "Europe/Berlin",
        },
        action: { ...action, projectKey: PROJECT_KEY, checkout: "worktree" },
      })).id!;
      yield* harness.engine.dispatch({ type: "automation.runNow", automationId: id });
      const create = (yield* Ref.get(harness.commands))[0]!;
      expect(create).toMatchObject({
        type: "thread.create",
        title: "Weekly audit",
        worktreePath: "/work/worktrees/abcd1234",
        branch: "t3code/abcd1234",
      });
      const automation = (yield* harness.store.snapshot).automations[0]!;
      expect(automation.nextRunAt).not.toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("refuses a schedule without a project or with a bad cron", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const base = {
        type: "automation.create" as const,
        title: "Nightly",
        prompt: "Do it",
        action,
      };
      const noProject = yield* harness.engine
        .dispatch({
          ...base,
          trigger: {
            type: "schedule",
            schedule: { kind: "cron", cron: "0 2 * * *" },
            timezone: "UTC",
          },
        })
        .pipe(Effect.flip);
      expect(noProject.message).toMatch(/needs a project/);
      const badCron = yield* harness.engine
        .dispatch({
          ...base,
          action: { ...action, projectKey: PROJECT_KEY },
          trigger: {
            type: "schedule",
            schedule: { kind: "cron", cron: "nightly" },
            timezone: "UTC",
          },
        })
        .pipe(Effect.flip);
      expect(badCron.message).toMatch(/Invalid schedule/);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("an any-board hook fires on every board's column of its type", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const boardId = (yield* harness.boards.dispatch(
        { type: "board.create", name: "Beta", key: "BETA", defaultProjectKey: PROJECT_KEY },
        "user",
      )).id!;
      yield* harness.engine.dispatch({
        type: "automation.create",
        title: "Test anything",
        prompt: "Test {{ticket.key}}",
        trigger: { type: "board", boardId: null, columnId: null, columnName: "review" },
        action,
      });
      const columns = (yield* harness.boards.snapshot).boards[0]!.columns;
      const review = columns.find((column) => column.name === "Review")!.id;
      const active = columns.find((column) => column.name === "In progress")!.id;
      const ticketId = (yield* harness.boards.dispatch(
        { type: "ticket.create", boardId, title: "Anywhere" },
        "user",
      )).id!;

      yield* harness.boardDispatch({ type: "ticket.move", ticketId, columnId: active });
      expect(yield* harness.threadIdsStarted).toEqual([]);
      yield* harness.boardDispatch({ type: "ticket.move", ticketId, columnId: review });
      const commands = yield* Ref.get(harness.commands);
      const turn = commands.find((command) => command.type === "thread.turn.start");
      expect(turn?.type === "thread.turn.start" && turn.message.text).toBe("Test BETA-1");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects an any-board hook without a column name", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const error = yield* harness.engine
        .dispatch({
          type: "automation.create",
          title: "Nowhere",
          prompt: "Test",
          trigger: { type: "board", boardId: null, columnId: null },
          action,
        })
        .pipe(Effect.flip);
      expect(error.message).toMatch(/Name the column/);
    }).pipe(Effect.provide(TestLayer)),
  );
  it.effect("runs built-in steps without a chat: close on entering Done", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { boardId, column, ticket } = yield* setupBoard(harness);
      yield* harness.engine.dispatch({
        type: "automation.create",
        title: "Close when done",
        prompt: "",
        trigger: { type: "board", boardId, columnId: column("Done") },
        action: { ...action, steps: [{ type: "setStatus", status: "done" }] },
      });
      const schema = yield* ticket("Schema");
      const endpoint = yield* ticket("Endpoint", [schema]);
      yield* harness.boardDispatch({
        type: "ticket.move",
        ticketId: schema,
        columnId: column("Done"),
      });
      const tickets = new Map((yield* harness.boards.snapshot).tickets.map((t) => [t.id, t]));
      expect(tickets.get(schema)!.status).toBe("done");
      // No chat started, and the dependent is no longer blocked.
      expect(yield* harness.threadIdsStarted).toEqual([]);
      expect(tickets.get(endpoint)!.requires).toEqual([schema]);
      const runs = (yield* harness.store.snapshot).runs;
      expect(runs.map((run) => run.status)).toContain("succeeded");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("flags the ticket when a step cannot run", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { boardId, column, ticket } = yield* setupBoard(harness);
      yield* harness.engine.dispatch({
        type: "automation.create",
        title: "Park it",
        prompt: "",
        trigger: { type: "board", boardId, columnId: column("Review") },
        action: { ...action, steps: [{ type: "moveTo", column: "Parking" }] },
      });
      const ticketId = yield* ticket("Lost");
      yield* harness.boardDispatch({ type: "ticket.move", ticketId, columnId: column("Review") });
      const flagged = (yield* harness.boards.snapshot).tickets[0]!;
      expect(flagged.flag).toMatchObject({ level: "error" });
      expect(flagged.flag?.reason).toMatch(/no column named "Parking"/);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("moves stale tickets between columns on a schedule", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { column, ticket } = yield* setupBoard(harness);
      const ticketId = yield* ticket("Old news");
      yield* harness.boards.dispatch(
        { type: "ticket.move", ticketId, columnId: column("Done") },
        "user",
      );
      const sweep = (olderThanDays: number) =>
        harness.engine.dispatch({
          type: "automation.create",
          title: `Settle after ${olderThanDays}`,
          prompt: "",
          trigger: {
            type: "schedule",
            schedule: { kind: "cron", cron: "0 3 * * *" },
            timezone: "UTC",
          },
          action: {
            ...action,
            steps: [{ type: "moveStale", from: "done", to: "Backlog", olderThanDays }],
          },
        });
      // A ticket moved just now is not stale yet.
      const recent = (yield* sweep(1)).id!;
      yield* harness.engine.dispatch({ type: "automation.runNow", automationId: recent });
      expect((yield* harness.boards.snapshot).tickets[0]!.columnId).toBe(column("Done"));
      expect(
        (yield* harness.engine
          .dispatch({
            type: "automation.create",
            title: "Wrong trigger",
            prompt: "",
            trigger: { type: "board", boardId: null, columnId: null, columnName: "Done" },
            action: {
              ...action,
              steps: [{ type: "moveStale", from: "Done", to: "Backlog", olderThanDays: 1 }],
            },
          })
          .pipe(Effect.flip)).message,
      ).toMatch(/runs on a schedule/);
    }).pipe(Effect.provide(TestLayer)),
  );
  it.effect("runs no hooks for a quiet move", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { column, ticket } = yield* setupBoard(harness);
      const ticketId = yield* ticket("Just tidying");
      yield* harness.boardDispatch({
        type: "ticket.move",
        ticketId,
        columnId: column("In progress"),
        quiet: true,
      });
      expect(yield* harness.threadIdsStarted).toEqual([]);
      expect((yield* harness.boards.snapshot).tickets[0]!.columnId).toBe(column("In progress"));
    }).pipe(Effect.provide(TestLayer)),
  );
});
