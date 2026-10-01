import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { AutomationAction, AutomationsCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { AutomationEngine } from "../automations/AutomationEngine.ts";
import {
  AutomationsStore,
  layerMemory as storeLayerMemory,
} from "../automations/AutomationsStore.ts";
import { BoardsService, layerMemory as boardsLayerMemory } from "../boards/BoardsService.ts";
import { BoardTemplates, layerMemory } from "./BoardTemplates.ts";

const action: AutomationAction = {
  projectKey: "env:project",
  modelSelection: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  checkout: "ticket",
};

/** Templates over in-memory boards and automations; the engine records what it is asked to create. */
const makeHarness = Effect.gen(function* () {
  const created = yield* Ref.make<ReadonlyArray<AutomationsCommand>>([]);
  const engine = Layer.mock(AutomationEngine)({
    dispatch: (command) =>
      Ref.update(created, (list) => [...list, command]).pipe(Effect.as({ id: "a" })),
  });
  const templates = yield* BoardTemplates.pipe(
    Effect.provide(layerMemory.pipe(Layer.provide(engine))),
  );
  return {
    templates,
    created,
    boards: yield* BoardsService,
    store: yield* AutomationsStore,
  };
});

const TestLayer = Layer.mergeAll(boardsLayerMemory, storeLayerMemory).pipe(
  Layer.provideMerge(NodeServices.layer),
);

describe("BoardTemplates", () => {
  it.effect("creates a board with a template's columns and automations", () =>
    Effect.gen(function* () {
      const { templates, created, boards } = yield* makeHarness;
      const boardId = (yield* templates.dispatch(
        { type: "board.create", templateId: "builtin:ship", name: "Atlas", key: "ATLAS" },
        "user",
      )).id!;
      const board = (yield* boards.snapshot).boards.find((candidate) => candidate.id === boardId)!;
      expect(board.columns.map((column) => column.name)).toEqual([
        "Backlog",
        "Todo",
        "In Progress",
        "Review",
        "Ready",
        "Close",
        "Push",
        "Done",
        "Settled",
        "Cancelled",
      ]);
      const columnName = (id: string | null) =>
        board.columns.find((column) => column.id === id)?.name;
      const commands = (yield* Ref.get(created)).flatMap((command) =>
        command.type === "automation.create" ? [command] : [],
      );
      expect(
        commands.flatMap(({ title, trigger }) =>
          trigger.type === "board" && trigger.boardId === boardId
            ? [[title, columnName(trigger.columnId)]]
            : [],
        ),
      ).toEqual([
        ["Implement", "In Progress"],
        ["Review", "Review"],
        ["Close", "Close"],
        ["Push", "Push"],
      ]);
      const settle = commands.find((command) => command.trigger.type === "schedule")!;
      expect(settle.title).toBe("Settle old Done tickets (Atlas)");
      expect(settle.action.steps).toEqual([
        { type: "moveStale", from: "Done", to: "Settled", olderThanDays: 7, boardId },
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("saves a board's hooks and its tidying schedules, replacing by name", () =>
    Effect.gen(function* () {
      const { templates, boards, store } = yield* makeHarness;
      const boardId = (yield* boards.dispatch(
        { type: "board.create", name: "Web", key: "WEB" },
        "user",
      )).id!;
      const review = (yield* boards.snapshot).boards[0]!.columns.find(
        (column) => column.name === "Review",
      )!.id;
      const schedule = {
        type: "schedule" as const,
        schedule: { kind: "cron" as const, cron: "0 6 * * *" },
        timezone: "UTC",
      };
      yield* store.create({
        title: "Verify",
        prompt: "Verify {{ticket.key}}",
        trigger: { type: "board", boardId, columnId: review },
        action,
        enabled: true,
        maxRunsPerTicket: 3,
      });
      yield* store.create({
        title: "Settle (Web)",
        prompt: "",
        trigger: schedule,
        action: {
          ...action,
          steps: [{ type: "moveStale", from: "Done", to: "Review", olderThanDays: 2, boardId }],
        },
        enabled: true,
        maxRunsPerTicket: 5,
      });
      // Not this board's: a chat schedule and a sweep over every board.
      yield* store.create({
        title: "Standup",
        prompt: "Summarize",
        trigger: schedule,
        action,
        enabled: true,
        maxRunsPerTicket: 5,
      });
      yield* store.create({
        title: "Settle everywhere",
        prompt: "",
        trigger: schedule,
        action: {
          ...action,
          steps: [{ type: "moveStale", from: "Done", to: "Review", olderThanDays: 2 }],
        },
        enabled: true,
        maxRunsPerTicket: 5,
      });

      const save = templates.dispatch(
        { type: "template.save", boardId, name: "Mine", description: "Mine" },
        "user",
      );
      const id = (yield* save).id!;
      expect((yield* save).id).toBe(id);
      const saved = (yield* templates.snapshot).templates.filter((template) => !template.builtIn);
      expect(saved.map((template) => template.name)).toEqual(["Mine"]);
      expect(saved[0]!.columns.map((column) => column.name)).toEqual([
        "Backlog",
        "Todo",
        "In progress",
        "Review",
        "Done",
      ]);
      expect(saved[0]!.automations).toMatchObject([
        { title: "Verify", trigger: { type: "board", column: "Review" }, maxRunsPerTicket: 3 },
        { title: "Settle", trigger: { type: "schedule", timezone: "UTC" } },
      ]);
      expect(saved[0]!.automations[0]!.action.projectKey).toBeNull();
      expect(saved[0]!.automations[1]!.action.steps).toEqual([
        { type: "moveStale", from: "Done", to: "Review", olderThanDays: 2, boardId: null },
      ]);

      const refused = yield* templates
        .dispatch({ type: "template.delete", templateId: "builtin:basic" }, "user")
        .pipe(Effect.flip);
      expect(refused.code).toBe("invalid");
      yield* templates.dispatch({ type: "template.delete", templateId: id }, "user");
      expect((yield* templates.snapshot).templates.filter((template) => !template.builtIn)).toEqual(
        [],
      );
    }).pipe(Effect.provide(TestLayer)),
  );
});
