import { createFileRoute } from "@tanstack/react-router";

import { BoardPage } from "../components/boards/BoardPage";

export const Route = createFileRoute("/boards/$boardKey/")({
  component: BoardRouteView,
});

function BoardRouteView() {
  const { boardKey } = Route.useParams();
  return <BoardPage boardKey={boardKey} />;
}
