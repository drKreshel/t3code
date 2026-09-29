import type { BoardColumnType, TicketPriority } from "@t3tools/contracts";

/** Dot color per column type; names are free, so color follows meaning. */
export const COLUMN_TYPE_DOT_CLASS: Record<BoardColumnType, string> = {
  backlog: "bg-muted-foreground/40",
  todo: "bg-muted-foreground/80",
  active: "bg-info",
  review: "bg-indigo-500 dark:bg-indigo-300/90",
  attention: "bg-warning",
  done: "bg-success",
  canceled: "bg-muted-foreground/25",
};

export const COLUMN_TYPE_LABEL: Record<BoardColumnType, string> = {
  backlog: "Backlog",
  todo: "To do",
  active: "In progress",
  review: "Review",
  attention: "Needs you",
  done: "Done",
  canceled: "Canceled",
};

export const COLUMN_TYPES: ReadonlyArray<BoardColumnType> = [
  "backlog",
  "todo",
  "active",
  "review",
  "attention",
  "done",
  "canceled",
];

export const PRIORITY_LABEL: Record<TicketPriority, string> = {
  none: "No priority",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

export const PRIORITIES: ReadonlyArray<TicketPriority> = [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
];
