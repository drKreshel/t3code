// @vitest-environment jsdom

import type { BoardRouteLinkTarget } from "@t3tools/shared/forkBoardLinks";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { MarkdownBoardRouteLink } from "./MarkdownBoardRouteLink";

let unmount: (() => void) | undefined;

afterEach(() => {
  unmount?.();
  unmount = undefined;
  vi.unstubAllGlobals();
});

async function renderLink(target: BoardRouteLinkTarget) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rootRoute = createRootRoute({
    component: () => <MarkdownBoardRouteLink target={target} label="Open item" />,
  });
  const boardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/boards/$boardKey",
  });
  const ticketRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/boards/$boardKey/$ticketNumber",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([boardRoute, ticketRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const container = document.createElement("div");
  const reactRoot = createRoot(container);
  unmount = () => {
    act(() => reactRoot.unmount());
  };
  await act(async () => {
    reactRoot.render(<RouterProvider router={router} />);
  });
  return { anchor: container.querySelector("a")!, router };
}

describe("MarkdownBoardRouteLink", () => {
  it.each([
    [{ kind: "board", boardKey: "SALON" } as const, "/boards/SALON"],
    [{ kind: "ticket", boardKey: "SALON", ticketNumber: 36 } as const, "/boards/SALON/36"],
  ])("navigates %s inside the app", async (target, path) => {
    const { anchor, router } = await renderLink(target);
    expect(anchor.getAttribute("href")).toBe(path);

    await act(async () => {
      anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
    });
    expect(router.state.location.pathname).toBe(path);
  });
});
