import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { BoardsService, layerMemory as boardsLayerMemory } from "../boards/BoardsService.ts";
import { BoardTemplates, layerMemory } from "./BoardTemplates.ts";

const TestLayer = layerMemory.pipe(
  Layer.provideMerge(boardsLayerMemory),
  Layer.provideMerge(NodeServices.layer),
);

describe("BoardTemplates", () => {
  it.effect("creates a board with a template's columns and their ticket moves", () =>
    Effect.gen(function* () {
      const templates = yield* BoardTemplates;
      const boards = yield* BoardsService;
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
      const column = (name: string) => board.columns.find((candidate) => candidate.name === name)!;
      expect(column("Done").autoMove).toEqual({
        afterDays: 7,
        toColumnId: column("Settled").id,
      });
      expect(column("Todo").autoMove).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("saves a board's columns and moves, replacing by name", () =>
    Effect.gen(function* () {
      const templates = yield* BoardTemplates;
      const boards = yield* BoardsService;
      const boardId = (yield* boards.dispatch(
        { type: "board.create", name: "Web", key: "WEB" },
        "user",
      )).id!;
      const columns = (yield* boards.snapshot).boards[0]!.columns;
      const column = (name: string) => columns.find((candidate) => candidate.name === name)!.id;
      yield* boards.dispatch(
        {
          type: "column.update",
          columnId: column("Done"),
          autoMove: { afterDays: 2, toColumnId: column("Review") },
        },
        "user",
      );

      const save = templates.dispatch(
        { type: "template.save", boardId, name: "Mine", description: "Mine" },
        "user",
      );
      const id = (yield* save).id!;
      expect((yield* save).id).toBe(id);
      const saved = (yield* templates.snapshot).templates.filter((template) => !template.builtIn);
      expect(saved.map((template) => template.name)).toEqual(["Mine"]);
      expect(saved[0]!.columns).toEqual([
        { name: "Backlog", color: null },
        { name: "Todo", color: null },
        { name: "In progress", color: "blue" },
        { name: "Review", color: "violet" },
        { name: "Done", color: "green", autoMove: { afterDays: 2, toColumn: "Review" } },
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
