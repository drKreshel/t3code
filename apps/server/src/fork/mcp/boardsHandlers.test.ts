import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { BoardsService, layerMemory } from "../boards/BoardsService.ts";
import { BoardsToolkitHandlersLive } from "./boardsHandlers.ts";
import { BoardsToolkit } from "./boardsTools.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const THREAD_ID = ThreadId.make("thread-1");
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_KEY = `${ENVIRONMENT_ID}:${THREAD_ID}`;

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: ENVIRONMENT_ID,
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["pull-requests"]),
  issuedAt: 1,
};

const project = { id: PROJECT_ID, title: "Atlas" } as OrchestrationProjectShell;
const thread = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Plan atlas",
} as OrchestrationThreadShell;

const snapshotQuery = Layer.mock(ProjectionSnapshotQuery)({
  getThreadShellById: (threadId) =>
    Effect.succeed(threadId === THREAD_ID ? Option.some(thread) : Option.none()),
  getProjectShellById: (projectId) =>
    Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
});

/** Calls tools as the chat THREAD_ID; the test provides the in-memory boards database. */
const makeHarness = Effect.gen(function* () {
  const toolkit = yield* BoardsToolkit.pipe(
    Effect.provide(BoardsToolkitHandlersLive.pipe(Layer.provide(snapshotQuery))),
  );
  const call = <Name extends keyof typeof BoardsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      // Failure mode is "error", so a delivered result is always the success shape.
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof BoardsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provide(snapshotQuery),
    );
  return { call };
});

const BoardsTestLayer = layerMemory.pipe(Layer.provide(NodeServices.layer));

describe("boards toolkit handlers", () => {
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

  it.effect("flags a ticket in place and reports requirements by column", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness;
      yield* call("create_board", { name: "Api", key: "API" });
      yield* call("create_ticket", { board: "API", title: "Schema" });
      yield* call("create_ticket", { board: "API", title: "Endpoint", requires: ["API-1"] });

      // Columns mean nothing, so a blocked ticket moves freely.
      const moved = yield* call("move_ticket", { ticket: "API-2", column: "in progress" });
      expect(moved.column).toBe("In progress");

      const escalated = yield* call("request_human", {
        ticket: "API-2",
        reason: "Which auth scheme?",
      });
      expect(escalated.column).toBe("In progress");
      const listed = yield* call("list_tickets", { board: "API", column: "In progress" });
      expect(listed.tickets).toMatchObject([
        {
          key: "API-2",
          flag: { level: "warning", reason: "Which auth scheme?" },
          requires: ["API-1 (Backlog)"],
        },
      ]);

      yield* call("move_ticket", { ticket: "API-1", column: "Done" });
      const detail = yield* call("get_ticket", { ticket: "API-2" });
      expect(detail.requires).toEqual([{ key: "API-1", title: "Schema", column: "Done" }]);
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
