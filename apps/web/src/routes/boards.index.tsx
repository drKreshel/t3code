import { createFileRoute } from "@tanstack/react-router";

import { BoardsIndexPage } from "../components/boards/BoardsIndexPage";

export const Route = createFileRoute("/boards/")({
  component: BoardsIndexPage,
});
