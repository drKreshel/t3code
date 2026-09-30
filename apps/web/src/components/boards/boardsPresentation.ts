import type { TicketPriority, TicketStatus } from "@t3tools/contracts";

/** Column colors a board can pick; a column without one gets the neutral dot. */
export const COLUMN_COLORS = ["gray", "blue", "violet", "amber", "green", "red"] as const;
export type ColumnColor = (typeof COLUMN_COLORS)[number];

const COLUMN_DOT_CLASS: Record<ColumnColor, string> = {
  gray: "bg-muted-foreground/40",
  blue: "bg-info",
  violet: "bg-indigo-500 dark:bg-indigo-300/90",
  amber: "bg-warning",
  green: "bg-success",
  red: "bg-destructive",
};

export const COLUMN_COLOR_LABEL: Record<ColumnColor, string> = {
  gray: "Gray",
  blue: "Blue",
  violet: "Violet",
  amber: "Amber",
  green: "Green",
  red: "Red",
};

/** The dot class for a column's stored color token. */
export function columnDotClass(color: string | null): string {
  return (color && COLUMN_DOT_CLASS[color as ColumnColor]) || "bg-muted-foreground/70";
}

export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Open",
  done: "Done",
  canceled: "Canceled",
};

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
