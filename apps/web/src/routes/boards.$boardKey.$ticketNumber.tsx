import { createFileRoute } from "@tanstack/react-router";

import { TicketPage } from "../components/boards/TicketPage";

export const Route = createFileRoute("/boards/$boardKey/$ticketNumber")({
  component: TicketRouteView,
});

function TicketRouteView() {
  const { boardKey, ticketNumber } = Route.useParams();
  return <TicketPage boardKey={boardKey} ticketNumber={Number(ticketNumber)} />;
}
