import { createFileRoute } from "@tanstack/react-router";

import { AutomationsPage } from "../components/automations/AutomationsPage";

export const Route = createFileRoute("/automations")({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: search.tab === "workflows" ? ("workflows" as const) : ("scheduled" as const),
  }),
  component: () => <AutomationsPage tab={Route.useSearch().tab} />,
});
