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
  const blockers = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
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
          if (command.type === "thread.request-human")
            yield* Ref.update(blockers, (entries) =>
              new Map(entries).set(command.threadId, command.reason),
            );
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
        Effect.all([Ref.get(turnStates), Ref.get(blockers)]).pipe(
          Effect.map(([states, pending]) => {
            const state = states.get(threadId);
            return state === undefined
              ? null
              : ({
                  id: threadId,
                  projectId: PROJECT_ID,
                  archivedAt: null,
                  pendingRuntimeRequest: pending.has(threadId)
                    ? { blockingReason: pending.get(threadId) }
                    : null,
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

  return {
    engine,
    boards,
    store,
    commands,
    turnStates,
    threadIdsStarted,
    endTurn,
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
    const ticket = (title: string) =>
      harness.boards
        .dispatch({ type: "ticket.create", boardId, title }, "user")
        .pipe(Effect.map((result) => result.id!));
    const linkChat = (ticketId: string, threadId: ThreadId) =>
      harness.boards.dispatch(
        { type: "thread.link", ticketId, threadKey: `${ENVIRONMENT_ID}:${threadId}` },
        "user",
      );
    return { boardId, column, ticket, linkChat };
  });

const weekly = {
  type: "schedule" as const,
  schedule: { kind: "cron" as const, cron: "0 9 * * 1" },
  timezone: "Europe/Berlin",
};

describe("AutomationEngine", () => {
  it.effect("creates, edits, and runs a schedule through MCP, then reports its last run", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const caller = ThreadId.make("caller");
      yield* Ref.update(harness.turnStates, (states) => new Map(states).set(caller, "completed"));
      const toolkit = yield* AutomationsToolkit.pipe(
        Effect.provide(AutomationsToolkitHandlersLive.pipe(Layer.provide(harness.fakes))),
        Effect.provideService(AutomationEngine, harness.engine),
        Effect.provideService(AutomationsStore, harness.store),
      );
      const invocation: McpInvocationContext.McpInvocationScope = {
        environmentId: ENVIRONMENT_ID,
        threadId: caller,
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
      const created = yield* call("create_automation", {
        title: "Weekly audit",
        prompt: "Audit the repo.",
        cron: "0 9 * * 1",
        timezone: "Europe/Berlin",
        useThisChatsProject: true,
      });
      yield* call("update_automation", {
        automation: "weekly audit",
        prompt: "Audit the changed queries.",
        cron: "0 10 * * 1",
      });
      const saved = yield* harness.store.get(created.id);
      expect(saved.prompt).toBe("Audit the changed queries.");
      expect(saved.action.projectKey).toBe(PROJECT_KEY);
      yield* call("run_automation", { automation: created.id });
      const [threadId] = yield* harness.threadIdsStarted;
      const message = (yield* Ref.get(harness.commands)).find(
        (command) => command.type === "message.dispatch",
      );
      expect(message).toMatchObject({ threadId, text: "Audit the changed queries." });
      yield* harness.endTurn(threadId!, "completed");
      const listed = (yield* call("list_automations", {})).automations;
      expect(listed).toEqual([
        expect.objectContaining({
          id: created.id,
          trigger: "cron 0 10 * * 1 (Europe/Berlin)",
          project: "Atlas",
          lastRun: expect.objectContaining({ status: "succeeded", reason: null }),
        }),
      ]);

      // A one-off without an offset is wall-clock time in its zone.
      const once = yield* call("create_automation", {
        title: "Nightly update",
        prompt: "Update.",
        at: "2030-01-15T04:00",
        timezone: "America/Vancouver",
        useThisChatsProject: true,
      });
      expect(once.trigger).toBe("once at 2030-01-15T04:00:00.000-08:00[America/Vancouver]");
      const savedOnce = yield* harness.store.get(once.id);
      expect(savedOnce.trigger.schedule).toEqual({ kind: "once", at: "2030-01-15T12:00:00.000Z" });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("settles each scheduled chat run by how its turn ended", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const automationId = (yield* harness.engine.dispatch({
        type: "automation.create",
        title: "Weekly audit",
        prompt: "Audit the repo.",
        trigger: weekly,
        action: { ...action, projectKey: PROJECT_KEY },
      })).id!;
      const runEndingAs = (state: TurnState) =>
        Effect.gen(function* () {
          yield* harness.engine.dispatch({ type: "automation.runNow", automationId });
          const threadId = (yield* harness.threadIdsStarted).at(-1)!;
          const threadKey = `${ENVIRONMENT_ID}:${threadId}`;
          const running = (yield* harness.store.snapshot).runs.find(
            (run) => run.threadKey === threadKey,
          );
          expect(running?.status).toBe("running");
          yield* harness.endTurn(threadId, state);
          return (yield* harness.store.snapshot).runs.find((run) => run.threadKey === threadKey);
        });
      expect(yield* runEndingAs("completed")).toMatchObject({ status: "succeeded", reason: null });
      expect(yield* runEndingAs("error")).toMatchObject({
        status: "failed",
        reason: "The chat's turn failed.",
      });
      expect(yield* runEndingAs("interrupted")).toMatchObject({
        status: "failed",
        reason: "The chat was stopped.",
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("deleting a chat fails its running run and unlinks it from its ticket", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { ticket, linkChat } = yield* setupBoard(harness);
      const ticketId = yield* ticket("Audit follow-up");
      const automationId = (yield* harness.engine.dispatch({
        type: "automation.create",
        title: "Weekly audit",
        prompt: "Audit the repo.",
        trigger: weekly,
        action: { ...action, projectKey: PROJECT_KEY },
      })).id!;
      yield* harness.engine.dispatch({ type: "automation.runNow", automationId });
      const [threadId] = yield* harness.threadIdsStarted;
      yield* linkChat(ticketId, threadId!);
      yield* Ref.update(harness.turnStates, (states) => {
        const next = new Map(states);
        next.delete(threadId!);
        return next;
      });
      yield* harness.engine.handleDomainEvent({
        type: "thread.deleted",
        threadId,
      } as unknown as OrchestrationV2DomainEvent);
      expect((yield* harness.store.snapshot).runs[0]).toMatchObject({
        status: "failed",
        reason: "The chat was deleted.",
      });
      expect((yield* harness.boards.snapshot).tickets[0]?.threadKeys).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("moves a legacy ticket blocker to the chat that raised it, once", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { ticket, linkChat } = yield* setupBoard(harness);
      const ticketId = yield* ticket("Blocked migration");
      const worker = ThreadId.make("worker");
      const threadKey = `${ENVIRONMENT_ID}:${worker}`;
      yield* Ref.update(harness.turnStates, (states) => new Map(states).set(worker, "completed"));
      yield* linkChat(ticketId, worker);
      const columnId = (yield* harness.boards.snapshot).tickets[0]!.columnId;
      yield* harness.boards.dispatch(
        { type: "ticket.flag", ticketId, level: "warning", reason: "Choose the account." },
        `thread:${threadKey}`,
      );
      yield* harness.engine.tick;
      yield* harness.engine.tick;
      expect((yield* harness.boards.snapshot).tickets[0]).toMatchObject({
        columnId,
        flag: null,
        threadKeys: [threadKey],
      });
      expect(
        (yield* Ref.get(harness.commands)).filter(
          (command) => command.type === "thread.request-human",
        ),
      ).toEqual([expect.objectContaining({ threadId: worker, reason: "Choose the account." })]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("links delegated child chats to the parent's ticket without launching extra work", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const { ticket, linkChat } = yield* setupBoard(harness);
      const ticketId = yield* ticket("Delegated review");
      const parent = ThreadId.make("parent");
      yield* linkChat(ticketId, parent);
      const delegate = (child: string, parentThreadId: ThreadId) =>
        harness.engine.handleDomainEvent({
          type: "thread.created",
          threadId: ThreadId.make(child),
          payload: { lineage: { parentThreadId } },
        } as unknown as OrchestrationV2DomainEvent);
      yield* delegate("review-child", parent);
      // A child of an unlinked chat stays unlinked.
      yield* delegate("stray-child", ThreadId.make("unlinked-parent"));
      expect((yield* harness.boards.snapshot).tickets[0]?.threadKeys).toEqual([
        `${ENVIRONMENT_ID}:${parent}`,
        `${ENVIRONMENT_ID}:review-child`,
      ]);
      expect(yield* harness.threadIdsStarted).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "links chats a ticket chat starts or briefs, but never moves another ticket's chat",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const { ticket, linkChat } = yield* setupBoard(harness);
        const ticketId = yield* ticket("Feature");
        const otherTicketId = yield* ticket("Other feature");
        const parent = ThreadId.make("parent");
        yield* linkChat(ticketId, parent);
        yield* linkChat(otherTicketId, ThreadId.make("other-ticket-chat"));
        const turnItem = (threadId: string, payload: Record<string, unknown>) =>
          harness.engine.handleDomainEvent({
            type: "turn-item.updated",
            threadId: ThreadId.make(threadId),
            payload,
          } as unknown as OrchestrationV2DomainEvent);
        // create_threads records the new chat in the parent's timeline.
        yield* turnItem("parent", { type: "thread_created", targetThreadId: "created-chat" });
        // t3_thread_launch and t3_thread_send deliver a message from the parent.
        yield* turnItem("launched-chat", { type: "user_message", senderThreadId: "parent" });
        yield* turnItem("other-ticket-chat", { type: "user_message", senderThreadId: "parent" });
        yield* turnItem("own-chat", { type: "user_message" });
        const [linked, other] = (yield* harness.boards.snapshot).tickets.toSorted(
          (a, b) => a.number - b.number,
        );
        expect(linked?.threadKeys.toSorted()).toEqual(
          ["created-chat", "launched-chat", "parent"].map((id) => `${ENVIRONMENT_ID}:${id}`),
        );
        expect(other?.threadKeys).toEqual([`${ENVIRONMENT_ID}:other-ticket-chat`]);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("runs a schedule on demand in its project, without a ticket", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const id = (yield* harness.engine.dispatch({
        type: "automation.create",
        title: "Weekly audit",
        prompt: "Audit the repo",
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
