import { createFileRoute } from "@tanstack/react-router";

import {
  ScheduledTasksPage,
  type ScheduledTasksSearch,
} from "../components/scheduledTasks/ScheduledTasksPage";

export const Route = createFileRoute("/scheduled/")({
  validateSearch: (raw: Record<string, unknown>): ScheduledTasksSearch => ({
    ...(typeof raw.q === "string" && raw.q ? { q: raw.q } : {}),
    ...(typeof raw.project === "string" && raw.project ? { project: raw.project } : {}),
  }),
  component: ScheduledTasksPage,
});
