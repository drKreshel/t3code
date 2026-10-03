import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type AutomationAction,
  type BoardsSnapshot,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2DomainEvent,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
  RunId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { Tool } from "effect/unstable/ai";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { AutomationsToolkit } from "../mcp/automationsTools.ts";
import { AutomationsToolkitHandlersLive } from "../mcp/automationsHandlers.ts";
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

type TurnState =
  | "preparing"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "error"
  | "interrupted"
  | "cancelled"
  | "rolled_back";

/**
 * Engine over in-memory boards and automations, with orchestration faked:
 * dispatched commands are recorded, and each chat's turn state is set by the test.
 */
const makeHarness = Effect.gen(function* () {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const turnStates = yield* Ref.make<ReadonlyMap<string, TurnState>>(new Map());
  const project = {
    id: PROJECT_ID,
    title: "Atlas",
    workspaceRoot: "/work/atlas",
  } as OrchestrationProjectShell;

  const fakes = Layer.mergeAll(
    Layer.mock(OrchestratorV2)({
      dispatch: (command) =>
        Effect.gen(function* () {
          yield* Ref.update(commands, (list) => [...list, command]);
          if (command.type === "thread.create")
            yield* Ref.update(turnStates, (states) =>
              new Map(states).set(command.threadId, "completed"),
            );
          if (command.type === "message.dispatch")
            yield* Ref.update(turnStates, (states) =>
              new Map(states).set(command.threadId, "running"),
            );
          if (command.type === "run.interrupt")
            yield* Ref.update(turnStates, (states) =>
              new Map(states).set(command.threadId, "interrupted"),
            );
          return { sequence: 1, storedEvents: [] };
        }),
      streamDomainEvents: Stream.empty,
      getThreadShell: (threadId) =>
        Ref.get(turnStates).pipe(
          Effect.map((states) => {
            const state = states.get(threadId);
            return state === undefined
              ? null
              : ({
                  id: threadId,
                  activeRunId: ["running", "preparing", "queued", "starting", "waiting"].includes(
                    state,
                  )
                    ? RunId.make(`run:${threadId}`)
                    : null,
                  status: state === "error" ? "failed" : state,
                  lastError: null,
                } as OrchestrationV2ThreadShell);
          }),
        ),
    }),
    Layer.mock(ProjectStoreV2)({
      getShell: (projectId) =>
        Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
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
        type: "run.updated",
        threadId,
        payload: { status: state === "error" ? "failed" : state },
      } as unknown as OrchestrationV2DomainEvent);
    });

  /** Dispatches through the same board service used by clients and tools. */
  const boardDispatch = (command: Parameters<typeof boards.dispatch>[0], actor = "user") =>
    boards.dispatch(command, actor);

  return {
    engine,
    boards,
    store,
    commands,
    turnStates,
    threadIdsStarted,
    endTurn,
    boardDispatch,
    fakes,
  };
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
    const presetId = (yield* harness.engine.dispatch({
      type: "automation.create",
      title: "Implement",
      prompt: "Implement {{ticket.key}}: {{ticket.title}}. Latest handoff: {{ticket.handoff}}",
      trigger: { type: "workflow" },
      action,
    })).id!;
    const preset = yield* harness.store.get(presetId);
    const workflow = {
      presetId: presetId,
      title: preset.title,
      prompt: preset.prompt,
      action: preset.action,
    };
    const ticket = (title: string, requires?: string[]) =>
      harness.boards
        .dispatch(
          { type: "ticket.create", boardId, title, workflow, ...(requires ? { requires } : {}) },
          "user",
        )
        .pipe(Effect.map((result) => result.id!));
    return { boardId, column, presetId, ticket };
  });

describe("AutomationEngine", () => {
  it.effect("creates and edits presets through MCP, then starts and pauses a linked ticket", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { boardId } = yield* setupBoard(harness);
      const toolkit = yield* AutomationsToolkit.pipe(
        Effect.provide(AutomationsToolkitHandlersLive.pipe(Layer.provide(harness.fakes))),
        Effect.provideService(AutomationEngine, harness.engine),
      );
      const invocation: McpInvocationContext.McpInvocationScope = {
        environmentId: ENVIRONMENT_ID,
        threadId: ThreadId.make("caller"),
        providerSessionId: "test",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const call = <Name extends keyof typeof AutomationsToolkit.tools>(
        name: Name,
        parameters: Parameters<typeof toolkit.handle<Name>>[1],
      ) =>
        toolkit.handle(name, parameters).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map(
            (items) =>
              items.at(-1)!.result as Tool.Success<(typeof AutomationsToolkit.tools)[Name]>,
          ),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provide(harness.fakes),
        );
      const modelSelection = {
        instanceId: ProviderInstanceId.make("custom-provider"),
        model: "custom-model",
      };
      const preset = yield* call("create_workflow", {
        title: "Small review",
        instructions: "Review and record findings.",
        modelSelection,
        checkout: "local",
      });
      const listed = (yield* call("list_workflows", {})).workflows.find(
        (workflow) => workflow.id === preset.id,
      )!;
      expect(listed.action.modelSelection).toEqual(modelSelection);
      yield* call("update_workflow", {
        workflow: preset.id,
        instructions: "Review the changed queries.",
        modelSelection: null,
      });
      const saved = yield* harness.store.get(preset.id);
      expect(saved.prompt).toBe("Review the changed queries.");
      expect(saved.action.modelSelection).toBeNull();
      const ticketId = (yield* harness.boards.dispatch(
        {
          type: "ticket.create",
          boardId,
          title: "Queries",
          workflow: {
            presetId: saved.id,
            title: saved.title,
            prompt: saved.prompt,
            action: saved.action,
          },
        },
        "user",
      )).id!;
      yield* harness.boards.dispatch(
        { type: "thread.link", ticketId, threadKey: `${ENVIRONMENT_ID}:${invocation.threadId}` },
        "user",
      );
      const started = yield* call("start_workflow", {});
      expect(started.ticket).toBe("ATLAS-1");
      expect(started.threadKey).toBe(
        (yield* harness.boards.snapshot).tickets[0]?.workflowThreadKey,
      );
      yield* call("pause_workflow", {});
      expect((yield* harness.boards.snapshot).tickets[0]?.flag?.level).toBe("warning");
    }).pipe(Effect.provide(TestLayer)),
  );
  it.effect("starts explicitly, resumes the same chat, and reads the latest ticket handoff", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { ticket, column } = yield* setupBoard(harness);
      const ticketId = yield* ticket("Meter notes");
      yield* harness.boardDispatch({ type: "ticket.move", ticketId, columnId: column("Review") });
      expect(yield* harness.threadIdsStarted).toEqual([]);
      yield* harness.engine.dispatch({ type: "ticket.startWorkflow", ticketId });
      const [threadId] = yield* harness.threadIdsStarted;
      expect((yield* harness.boards.snapshot).tickets[0]?.workflowThreadKey).toBe(
        `${ENVIRONMENT_ID}:${threadId}`,
      );
      yield* harness.endTurn(threadId!, "completed");
      yield* harness.boards.dispatch(
        {
          type: "comment.add",
          ticketId,
          body: "Review found one layout issue. Fix that next.",
          isHandoff: true,
        },
        "user",
      );
      yield* harness.engine.dispatch({ type: "ticket.startWorkflow", ticketId });
      expect(yield* harness.threadIdsStarted).toEqual([threadId]);
      const messages = (yield* Ref.get(harness.commands)).filter(
        (command) => command.type === "message.dispatch",
      );
      expect(messages).toHaveLength(2);
      expect(messages[1]?.threadId).toBe(threadId);
      expect(messages[1]?.text).toContain("Review found one layout issue.");
      const detail = yield* Stream.runHead(harness.boards.ticketDetailStream(ticketId));
      expect(Option.isSome(detail) && detail.value.events.map((event) => event.kind)).toEqual(
        expect.arrayContaining(["workflow.started", "workflow.finished", "workflow.resumed"]),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("serializes simultaneous starts and refuses a second execution", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { ticket } = yield* setupBoard(harness);
      const ticketId = yield* ticket("One owner");
      const results = yield* Effect.all(
        [
          harness.engine.dispatch({ type: "ticket.startWorkflow", ticketId }).pipe(Effect.result),
          harness.engine.dispatch({ type: "ticket.startWorkflow", ticketId }).pipe(Effect.result),
        ],
        { concurrency: 2 },
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      expect(yield* harness.threadIdsStarted).toHaveLength(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("waits for preparation and approvals, and detects active manual sessions", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { ticket } = yield* setupBoard(harness);
      const ticketId = yield* ticket("Manual work");
      const manual = ThreadId.make("manual");
      yield* harness.boards.dispatch(
        { type: "thread.link", ticketId, threadKey: `${ENVIRONMENT_ID}:${manual}` },
        "user",
      );
      for (const state of ["preparing", "waiting", "running"] as const) {
        yield* Ref.update(harness.turnStates, (states) => new Map(states).set(manual, state));
        const error = yield* harness.engine
          .dispatch({ type: "ticket.startWorkflow", ticketId })
          .pipe(Effect.flip);
        expect(error.message).toMatch(/already working/);
      }
      expect(yield* harness.threadIdsStarted).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("pauses with a warning, holds the queue, and resumes without a new session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { ticket } = yield* setupBoard(harness);
      const ticketId = yield* ticket("Pause me");
      yield* harness.engine.dispatch({ type: "ticket.startWorkflow", ticketId });
      yield* harness.engine.dispatch({ type: "ticket.pauseWorkflow", ticketId });
      expect(
        (yield* Ref.get(harness.commands)).find((command) => command.type === "run.interrupt"),
      ).toMatchObject({ holdQueue: true });
      expect((yield* harness.boards.snapshot).tickets[0]?.flag?.level).toBe("warning");
      yield* harness.engine.dispatch({ type: "ticket.startWorkflow", ticketId });
      expect(yield* harness.threadIdsStarted).toHaveLength(1);
      expect((yield* harness.boards.snapshot).tickets[0]?.flag).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps instruction snapshots and assigned tickets usable after retiring a preset", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { ticket, presetId } = yield* setupBoard(harness);
      const ticketId = yield* ticket("Keep instructions");
      yield* harness.engine.dispatch({
        type: "automation.update",
        automationId: presetId,
        prompt: "Replacement process",
      });
      yield* harness.engine.dispatch({ type: "automation.delete", automationId: presetId });
      yield* harness.engine.dispatch({ type: "ticket.startWorkflow", ticketId });
      const message = (yield* Ref.get(harness.commands)).find(
        (command) => command.type === "message.dispatch",
      );
      expect(message?.text).toContain("Implement ATLAS-1: Keep instructions");
      expect(message?.text).not.toContain("Replacement process");
      expect((yield* harness.store.get(presetId)).enabled).toBe(false);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("links delegated child chats to the same ticket without launching extra work", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { ticket } = yield* setupBoard(harness);
      const ticketId = yield* ticket("Delegated review");
      yield* harness.engine.dispatch({ type: "ticket.startWorkflow", ticketId });
      const [parent] = yield* harness.threadIdsStarted;
      const child = ThreadId.make("review-child");
      yield* harness.engine.handleDomainEvent({
        type: "thread.created",
        threadId: child,
        payload: { lineage: { parentThreadId: parent } },
      } as unknown as OrchestrationV2DomainEvent);
      expect((yield* harness.boards.snapshot).tickets[0]?.threadKeys).toEqual([
        `${ENVIRONMENT_ID}:${parent}`,
        `${ENVIRONMENT_ID}:${child}`,
      ]);
      expect(yield* harness.threadIdsStarted).toHaveLength(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("replaces a deleted owner session and retains its ticket history", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { ticket } = yield* setupBoard(harness);
      const ticketId = yield* ticket("Recover owner");
      yield* harness.engine.dispatch({ type: "ticket.startWorkflow", ticketId });
      const [owner] = yield* harness.threadIdsStarted;
      yield* Ref.update(harness.turnStates, (states) => {
        const next = new Map(states);
        next.delete(owner!);
        return next;
      });
      yield* harness.engine.handleDomainEvent({
        type: "thread.deleted",
        threadId: owner,
      } as unknown as OrchestrationV2DomainEvent);
      expect((yield* harness.boards.snapshot).tickets[0]?.workflowThreadKey).toBeNull();
      yield* harness.engine.dispatch({ type: "ticket.startWorkflow", ticketId });
      expect(yield* harness.threadIdsStarted).toHaveLength(2);
      const secondOwner = (yield* harness.threadIdsStarted)[1]!;
      yield* harness.endTurn(secondOwner, "completed");
      yield* Ref.update(harness.turnStates, (states) => {
        const next = new Map(states);
        next.delete(secondOwner);
        return next;
      });
      yield* harness.engine.handleDomainEvent({
        type: "thread.deleted",
        threadId: secondOwner,
      } as unknown as OrchestrationV2DomainEvent);
      expect((yield* harness.boards.snapshot).tickets[0]?.workflowThreadKey).toBeNull();
      yield* harness.engine.dispatch({ type: "ticket.startWorkflow", ticketId });
      expect(yield* harness.threadIdsStarted).toHaveLength(3);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("refuses column hooks and does not start work when a human flag is resolved", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { ticket, boardId, column } = yield* setupBoard(harness);
      const ticketId = yield* ticket("Explicit only");
      const error = yield* harness.engine
        .dispatch({
          type: "automation.create",
          title: "Old hook",
          prompt: "Do work",
          trigger: { type: "board", boardId, columnId: column("Review") },
          action,
        })
        .pipe(Effect.flip);
      expect(error.message).toMatch(/replaced by ticket workflows/);
      yield* harness.boardDispatch({
        type: "ticket.flag",
        ticketId,
        level: "warning",
        reason: "Needs a decision",
      });
      yield* harness.boardDispatch({ type: "ticket.resolveFlag", ticketId });
      expect(yield* harness.threadIdsStarted).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects legacy ticket steps on schedules", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      for (const step of [
        { type: "moveTo", column: "Done" },
        { type: "removeWorkspace" },
      ] as const) {
        const error = yield* harness.engine
          .dispatch({
            type: "automation.create",
            title: "Legacy ticket action",
            prompt: "",
            trigger: {
              type: "schedule",
              schedule: { kind: "cron", cron: "0 3 * * *" },
              timezone: "UTC",
            },
            action: { ...action, checkout: "local", steps: [step] },
          })
          .pipe(Effect.flip);
        expect(error.message).toMatch(/workflow instructions/);
      }
      expect(yield* harness.threadIdsStarted).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("records workflow failures on the ticket and flags it for a human", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { ticket } = yield* setupBoard(harness);
      const ticketId = yield* ticket("Failure");
      yield* harness.engine.dispatch({ type: "ticket.startWorkflow", ticketId });
      const [owner] = yield* harness.threadIdsStarted;
      yield* harness.endTurn(owner!, "error");
      expect((yield* harness.boards.snapshot).tickets[0]?.flag?.level).toBe("error");
      expect((yield* harness.store.snapshot).runs[0]?.status).toBe("failed");
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
      const automation = (yield* harness.store.snapshot).automations.find(
        (candidate) => candidate.id === id,
      )!;
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
      ).toMatch(/replaced by ticket workflows/);
    }).pipe(Effect.provide(TestLayer)),
  );
  it.effect("sweeps only the board a stale-ticket step names", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { boardId, column, ticket } = yield* setupBoard(harness);
      const ticketId = yield* ticket("Old news");
      yield* harness.boards.dispatch(
        { type: "ticket.move", ticketId, columnId: column("Done") },
        "user",
      );
      yield* TestClock.adjust("2 days");
      const sweep = (target: string) =>
        Effect.gen(function* () {
          const automationId = (yield* harness.engine.dispatch({
            type: "automation.create",
            title: `Settle ${target}`,
            prompt: "",
            trigger: {
              type: "schedule",
              schedule: { kind: "cron", cron: "0 3 * * *" },
              timezone: "UTC",
            },
            action: {
              ...action,
              steps: [
                {
                  type: "moveStale",
                  from: "Done",
                  to: "Backlog",
                  olderThanDays: 1,
                  boardId: target,
                },
              ],
            },
          })).id!;
          yield* harness.engine.dispatch({ type: "automation.runNow", automationId });
          return (yield* harness.boards.snapshot).tickets[0]!.columnId;
        });
      expect(yield* sweep("another-board")).toBe(column("Done"));
      expect(yield* sweep(boardId)).toBe(column("Backlog"));
    }).pipe(Effect.provide(TestLayer)),
  );
  it.effect("a one-off moved to a new time fires again", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const once = (at: string) => ({
        type: "schedule" as const,
        schedule: { kind: "once" as const, at },
        timezone: "UTC",
      });
      const id = yield* harness.store.create({
        title: "Remind me",
        prompt: "Remind",
        trigger: once("2030-01-01T09:00:00.000Z"),
        action: { ...action, projectKey: PROJECT_KEY },
        enabled: true,
        maxRunsPerTicket: 5,
      });
      yield* harness.store.markFired(id, "2030-01-01T09:00:00.000Z");
      expect((yield* harness.store.get(id)).nextRunAt).toBeNull();
      yield* harness.store.update(id, { trigger: once("2030-02-01T09:00:00.000Z") });
      expect((yield* harness.store.get(id)).nextRunAt).toBe("2030-02-01T09:00:00.000Z");
      // Saving it unchanged does not bring a fired one-off back.
      yield* harness.store.markFired(id, "2030-02-01T09:00:00.000Z");
      yield* harness.store.update(id, { trigger: once("2030-02-01T09:00:00.000Z") });
      expect((yield* harness.store.get(id)).nextRunAt).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );
});
