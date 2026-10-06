import {
  BOARD_COLUMN_COLORS,
  type BoardColumnColor,
  type TicketPriority,
} from "@t3tools/contracts";

export const COLUMN_COLORS = BOARD_COLUMN_COLORS;
export type ColumnColor = BoardColumnColor;

const COLUMN_DOT_CLASS: Record<ColumnColor, string> = {
  gray: "bg-muted-foreground/40",
  slate: "bg-slate-500 dark:bg-slate-400",
  red: "bg-destructive",
  orange: "bg-orange-500 dark:bg-orange-400",
  amber: "bg-warning",
  yellow: "bg-yellow-400 dark:bg-yellow-300",
  lime: "bg-lime-500 dark:bg-lime-400",
  green: "bg-success",
  teal: "bg-teal-500 dark:bg-teal-400",
  cyan: "bg-cyan-500 dark:bg-cyan-400",
  blue: "bg-info",
  violet: "bg-indigo-500 dark:bg-indigo-300/90",
  purple: "bg-purple-500 dark:bg-purple-400",
  pink: "bg-pink-500 dark:bg-pink-400",
  brown: "bg-amber-800 dark:bg-amber-700",
};

export const COLUMN_COLOR_LABEL: Record<ColumnColor, string> = {
  gray: "Gray",
  slate: "Slate",
  red: "Red",
  orange: "Orange",
  amber: "Amber",
  yellow: "Yellow",
  lime: "Lime",
  green: "Green",
  teal: "Teal",
  cyan: "Cyan",
  blue: "Blue",
  violet: "Violet",
  purple: "Purple",
  pink: "Pink",
  brown: "Brown",
};

/** The dot class for a column's stored color token. */
export function columnDotClass(color: string | null): string {
  return (color && COLUMN_DOT_CLASS[color as ColumnColor]) || "bg-muted-foreground/70";
}

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
