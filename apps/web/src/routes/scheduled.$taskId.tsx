import { createFileRoute } from "@tanstack/react-router";

import { ScheduledTaskPage } from "../components/scheduledTasks/ScheduledTaskPage";

export const Route = createFileRoute("/scheduled/$taskId")({
  component: ScheduledTaskRouteView,
});

function ScheduledTaskRouteView() {
  const { taskId } = Route.useParams();
  return <ScheduledTaskPage key={taskId} taskId={taskId} />;
}
