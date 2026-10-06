/**
 * Turning boards into templates. Pure, so the service only stores and dispatches.
 */
import type { Board, BoardTemplate, ColumnSpec } from "@t3tools/contracts";

/** A board's columns as template columns; moves name their target column. */
export function templateColumnsOf(board: Board): ColumnSpec[] {
  const columns = board.columns.toSorted((a, b) => a.position - b.position);
  return columns.map((column) => {
    const target = column.autoMove
      ? columns.find((candidate) => candidate.id === column.autoMove?.toColumnId)
      : undefined;
    return {
      name: column.name,
      color: column.color,
      ...(column.autoMove && target
        ? { autoMove: { afterDays: column.autoMove.afterDays, toColumn: target.name } }
        : {}),
    };
  });
}

export const BUILT_IN_TEMPLATES: ReadonlyArray<BoardTemplate> = [
  {
    id: "builtin:basic",
    name: "Basic",
    description: "Plain columns.",
    builtIn: true,
    columns: [
      { name: "Backlog", color: null },
      { name: "Todo", color: null },
      { name: "In progress", color: "blue" },
      { name: "Review", color: "violet" },
      { name: "Done", color: "green" },
    ],
  },
  {
    id: "builtin:ship",
    name: "Ship with agents",
    description: "Delivery columns where Done tickets settle after a week.",
    builtIn: true,
    columns: [
      { name: "Backlog", color: null },
      { name: "Todo", color: "slate" },
      { name: "In Progress", color: "blue" },
      { name: "Review", color: "violet" },
      { name: "Ready", color: "teal" },
      { name: "Close", color: "orange" },
      { name: "Push", color: "cyan" },
      { name: "Done", color: "green", autoMove: { afterDays: 7, toColumn: "Settled" } },
      { name: "Settled", color: "gray" },
      { name: "Cancelled", color: "red" },
    ],
  },
];
