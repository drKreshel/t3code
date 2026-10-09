import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { BoardsService, layerMemory } from "../boards/BoardsService.ts";
import { BoardsToolkitHandlersLive } from "./boardsHandlers.ts";
import { BoardsToolkit } from "./boardsTools.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const THREAD_ID = ThreadId.make("thread-1");
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_KEY = `${ENVIRONMENT_ID}:${THREAD_ID}`;

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: ENVIRONMENT_ID,
  requestNamespace: "provider-session-1",
  client: undefined,
  thread: {
    threadId: THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const project = { id: PROJECT_ID, title: "Atlas" } as OrchestrationProjectShell;
// A live run in full-access/default mode, so McpToolAccess lets it act.
const thread = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Plan atlas",
  providerInstanceId: ProviderInstanceId.make("codex"),
  activeRunId: RunId.make("run-1"),
  runtimeMode: "full-access",
  interactionMode: "default",
  archivedAt: null,
  deletedAt: null,
} as unknown as OrchestrationV2ThreadShell;

const snapshotQuery = Layer.mergeAll(
  Layer.mock(OrchestratorV2)({
    dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
    getThreadShell: (threadId) => Effect.succeed(threadId === THREAD_ID ? thread : null),
  }),
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) => Effect.succeed(threadId === THREAD_ID ? thread : null),
  }),
  Layer.mock(ProjectStoreV2)({
    getShell: (projectId) =>
      Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
  }),
);

/** Calls tools as the chat THREAD_ID; the test provides the in-memory boards database. */
const makeHarness = Effect.gen(function* () {
  const toolkit = yield* BoardsToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(BoardsToolkitHandlersLive).pipe(
        Layer.provide(snapshotQuery),
      ),
    ),
  );
  const call = <Name extends keyof typeof BoardsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    scope = invocation,
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      // Failure mode is "error", so a delivered result is always the success shape.
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof BoardsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(snapshotQuery),
    );
  return { call };
});

const BoardsTestLayer = layerMemory.pipe(Layer.provide(NodeServices.layer));

describe("boards toolkit handlers", () => {
  it.effect("creates, lists, changes, and clears board icons through MCP", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness;
      const icon = { kind: "emoji", emoji: "🚀" } as const;
      expect((yield* call("create_board", { name: "Icons", key: "ICON", icon })).icon).toEqual(
        icon,
      );
      expect((yield* call("list_boards", {})).boards[0]!.icon).toEqual(icon);
      const next = { kind: "lucide", name: "rocket", color: "blue" } as const;
      expect((yield* call("update_board", { board: "ICON", icon: next })).icon).toEqual(next);
      yield* call("update_board", { board: "ICON", name: "Renamed" });
      expect((yield* call("list_boards", {})).boards[0]!.icon).toEqual(next);
      expect((yield* call("update_board", { board: "ICON", icon: null })).icon).toBeNull();
    }).pipe(Effect.provide(BoardsTestLayer)),
  );
  it.effect("rejects threadless board mutations without creating a board", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness;
      const error = yield* call(
        "create_board",
        { name: "External", key: "EXT" },
        {
          ...invocation,
          thread: undefined,
          client: { sessionId: "external", label: "External", access: "full-access" },
        },
      ).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "invalid" });
      expect((yield* call("list_boards", {})).boards).toEqual([]);
    }).pipe(Effect.provide(BoardsTestLayer)),
  );

  it.effect("lets a skill assign, change, and clear a ticket folder through board tools", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness;
      yield* call("create_board", { name: "SalonesDeFiestas", key: "SALON" });
      yield* call("create_ticket", {
        board: "SALON",
        title: "Kids venues",
        folder: "SalonesDeFiestas/salones-infantiles",
        linkThisChat: true,
      });
      expect((yield* call("get_ticket", {})).folder).toBe("SalonesDeFiestas/salones-infantiles");
      yield* call("update_ticket", { folder: "SalonesDeFiestas/venues" });
      expect((yield* call("get_ticket", {})).folder).toBe("SalonesDeFiestas/venues");
      yield* call("update_ticket", { folder: null });
      expect((yield* call("get_ticket", {})).folder).toBeNull();
    }).pipe(Effect.provide(BoardsTestLayer)),
  );
  it.effect("renumbers a ticket to match an outside key and keeps new numbers clear of it", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness;
      yield* call("create_board", { name: "Ecoplanet", key: "EI" });
      yield* call("create_ticket", { board: "EI", title: "Import" });
      yield* call("create_ticket", { board: "EI", title: "Export" });
      const renumbered = yield* call("update_ticket", { ticket: "EI-1", number: 2911 });
      expect(renumbered.key).toBe("EI-2911");
      expect((yield* call("get_ticket", { ticket: "EI-2911" })).title).toBe("Import");

      const error = yield* call("update_ticket", { ticket: "EI-2", number: 2911 }).pipe(
        Effect.flip,
      );
      expect(error).toMatchObject({ code: "key-taken" });

      const next = yield* call("create_ticket", { board: "EI", title: "Sync" });
      expect(next.key).toBe("EI-2912");
    }).pipe(Effect.provide(BoardsTestLayer)),
  );
  it.effect("creates a board and a linked ticket the chat can then read without a key", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness;
      const board = yield* call("create_board", {
        name: "Atlas",
        key: "ATLAS",
        useThisChatsProject: true,
      });
      expect(board.defaultProject).toBe("Atlas");
      expect(board.columns.map((column) => column.name)).toContain("Review");

      const created = yield* call("create_ticket", {
        board: "atlas",
        title: "Meter notes",
        criteria: ["Notes show in overview", "Notes are editable"],
        linkThisChat: true,
      });
      expect(created).toEqual({ key: "ATLAS-1", column: "Backlog", path: "/boards/ATLAS/1" });

      const ticket = yield* call("get_ticket", {});
      expect(ticket.key).toBe("ATLAS-1");
      expect(ticket.thisChatIsLinked).toBe(true);
      expect(ticket.project).toBe("Atlas");
      expect(ticket.criteria.map((criterion) => criterion.number)).toEqual([1, 2]);
    }).pipe(Effect.provide(BoardsTestLayer)),
  );

  it.effect("checks criteria by number or text and records the chat as the actor", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness;
      yield* call("create_board", { name: "Web", key: "WEB" });
      yield* call("create_ticket", {
        board: "WEB",
        title: "Login",
        criteria: ["Repro written", "Stays signed in"],
      });
      yield* call("update_ticket", {
        ticket: "WEB-1",
        checkCriteria: ["1", "stays signed in"],
        addCriteria: ["Tested on mobile"],
      });
      const ticket = yield* call("get_ticket", { ticket: "WEB-1" });
      expect(ticket.criteria).toEqual([
        { number: 1, text: "Repro written", checked: true },
        { number: 2, text: "Stays signed in", checked: true },
        { number: 3, text: "Tested on mobile", checked: false },
      ]);

      const boards = yield* BoardsService;
      const detail = yield* boards
        .ticketDetailStream((yield* boards.snapshot).tickets[0]!.id)
        .pipe(Stream.take(1), Stream.runCollect);
      const checkEvents = [...detail][0]!.events.filter(
        (event) => event.kind === "criterion.checked",
      );
      expect(checkEvents.map((event) => event.actor)).toEqual([
        `thread:${THREAD_KEY}`,
        `thread:${THREAD_KEY}`,
      ]);
    }).pipe(Effect.provide(BoardsTestLayer)),
  );

  it.effect("requests help in this chat and keeps ticket progress and requirements intact", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness;
      yield* call("create_board", { name: "Api", key: "API" });
      yield* call("create_ticket", { board: "API", title: "Schema" });
      yield* call("create_ticket", { board: "API", title: "Endpoint", requires: ["API-1"] });

      // Columns mean nothing, so a blocked ticket moves freely.
      const moved = yield* call("move_ticket", { ticket: "API-2", column: "in progress" });
      expect(moved.column).toBe("In progress");

      const escalated = yield* call("request_human", {
        reason: "Which auth scheme?",
      });
      expect(escalated).toEqual({ threadId: THREAD_ID, path: `/${ENVIRONMENT_ID}/${THREAD_ID}` });
      const listed = yield* call("list_tickets", { board: "API", column: "In progress" });
      expect(listed.tickets).toMatchObject([
        {
          key: "API-2",
          flag: null,
          requires: ["API-1 (Backlog)"],
        },
      ]);

      yield* call("move_ticket", { ticket: "API-1", column: "Done" });
      const detail = yield* call("get_ticket", { ticket: "API-2" });
      expect(detail.requires).toEqual([{ key: "API-1", title: "Schema", column: "Done" }]);
    }).pipe(Effect.provide(BoardsTestLayer)),
  );

  it.effect("edits columns in one call, moving tickets out of removed ones", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness;
      yield* call("create_board", { name: "Eco", key: "ECO" });
      yield* call("create_ticket", { board: "ECO", title: "Meter", column: "Todo" });

      const board = yield* call("update_board", {
        board: "eco",
        updateColumns: [
          { column: "review", color: "amber" },
          // A move can target a column this call adds.
          { column: "Done", autoMove: { afterDays: 7, to: "testing" } },
        ],
        addColumns: [{ name: "Testing", color: "cyan" }],
        removeColumns: [{ column: "Todo", moveTicketsTo: "Backlog" }],
        columnOrder: ["Backlog", "In progress", "Testing", "Review", "Done"],
      });
      expect(board.columns).toEqual([
        { name: "Backlog", color: null, tickets: 1, autoMove: null },
        { name: "In progress", color: "blue", tickets: 0, autoMove: null },
        { name: "Testing", color: "cyan", tickets: 0, autoMove: null },
        { name: "Review", color: "amber", tickets: 0, autoMove: null },
        {
          name: "Done",
          color: "green",
          tickets: 0,
          autoMove: { afterDays: 7, to: "Testing" },
        },
      ]);
      const stopped = yield* call("update_board", {
        board: "ECO",
        updateColumns: [{ column: "Done", autoMove: null }],
      });
      expect(stopped.columns.at(-1)?.autoMove).toBeNull();
      expect((yield* call("get_ticket", { ticket: "ECO-1" })).column).toBe("Backlog");

      // Renames can swap names; the order uses the new ones.
      const swapped = yield* call("update_board", {
        board: "ECO",
        updateColumns: [
          { column: "Backlog", name: "Done" },
          { column: "Done", name: "Backlog" },
        ],
      });
      expect(swapped.columns.map((column) => column.name)).toEqual([
        "Done",
        "In progress",
        "Testing",
        "Review",
        "Backlog",
      ]);
    }).pipe(Effect.provide(BoardsTestLayer)),
  );

  it.effect("changes nothing when a column edit is refused", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness;
      yield* call("create_board", {
        name: "Eco",
        key: "ECO",
        columns: [{ name: "Todo" }, { name: "Doing", color: "blue" }, { name: "Done" }],
      });
      yield* call("create_ticket", { board: "ECO", title: "Meter" });

      const refusals = [
        { removeColumns: [{ column: "Todo" }] },
        { addColumns: [{ name: "doing" }] },
        { columnOrder: ["Done", "Todo"] },
        { removeColumns: [{ column: "Doing", moveTicketsTo: "Doing" }] },
      ];
      for (const edits of refusals) {
        const error = yield* call("update_board", { board: "ECO", name: "Renamed", ...edits }).pipe(
          Effect.flip,
        );
        expect(error).toMatchObject({ code: "invalid" });
      }
      const [board] = (yield* call("list_boards", {})).boards;
      expect(board!.name).toBe("Eco");
      expect(board!.columns.map((column) => column.name)).toEqual(["Todo", "Doing", "Done"]);
    }).pipe(Effect.provide(BoardsTestLayer)),
  );

  it.effect("explains what exists when a name does not match", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness;
      yield* call("create_board", { name: "Web", key: "WEB" });
      const error = yield* call("list_tickets", { board: "WEB", column: "QA" }).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "not-found" });
      expect(String((error as { message: string }).message)).toContain("Columns: Backlog, Todo");
    }).pipe(Effect.provide(BoardsTestLayer)),
  );
});
