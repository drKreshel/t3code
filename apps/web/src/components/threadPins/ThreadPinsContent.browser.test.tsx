import { EnvironmentId, ThreadId, type ThreadPins } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/entities", () => ({
  useProject: () => null,
  useServerConfigs: () => new Map(),
  useThreadShell: () => null,
}));
vi.mock("../../state/threadPins", () => ({
  isUrlPinTarget: () => false,
  useThreadPinsDispatch: () => vi.fn(),
}));
vi.mock("../ChatMarkdown", () => ({
  default: ({ text }: { readonly text: string }) => <span data-note-markdown={text} />,
}));

import { ThreadPinsContent } from "./ThreadPinsContent";
import { useUiStateStore } from "../../uiStateStore";

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
const pins: ThreadPins = {
  threadId: threadRef.threadId,
  pins: [
    {
      id: "note-1",
      title: "Delivery map",
      target: null,
      text: "Agent one is running",
      createdAt: "2026-10-11T00:00:00.000Z",
      updatedAt: "2026-10-11T00:00:00.000Z",
    },
  ],
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useUiStateStore.setState({ collapsedThreadPinNoteKeys: [] });
  vi.unstubAllGlobals();
});

function render() {
  return act(async () =>
    root.render(
      <ThreadPinsContent
        threadRef={threadRef}
        pins={pins}
        onOpenFile={vi.fn()}
        onOpenUrl={vi.fn()}
      />,
    ),
  );
}

const noteBodies = () => container.querySelectorAll("[data-thread-pin-note-body]");
const toggle = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

it("remembers a collapsed pinned note when the chat view remounts", async () => {
  await render();
  expect(noteBodies()).toHaveLength(1);
  expect(container.querySelectorAll('[data-note-markdown="Agent one is running"]')).toHaveLength(1);

  await act(async () => toggle("Collapse Delivery map").click());
  expect(noteBodies()).toHaveLength(0);
  expect(toggle("Expand Delivery map").getAttribute("aria-expanded")).toBe("false");

  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(noteBodies()).toHaveLength(0);
  expect(toggle("Expand Delivery map").getAttribute("aria-expanded")).toBe("false");

  await act(async () => toggle("Expand Delivery map").click());
  expect(noteBodies()).toHaveLength(1);
});
