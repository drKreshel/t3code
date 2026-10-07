import { createFileRoute } from "@tanstack/react-router";

import { ScheduledTasksPage } from "../components/scheduledTasks/ScheduledTasksPage";

export const Route = createFileRoute("/scheduled")({
  component: ScheduledTasksPage,
});
