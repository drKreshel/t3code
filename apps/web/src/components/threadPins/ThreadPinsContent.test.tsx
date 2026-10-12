import { EnvironmentId, ThreadId, type ThreadPins } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

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

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  useUiStateStore.setState({ collapsedThreadPinNoteKeys: [] });
  vi.unstubAllGlobals();
});

it("remembers a collapsed pinned note when the chat view remounts", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  act(() => {
    renderer = create(
      <ThreadPinsContent
        threadRef={threadRef}
        pins={pins}
        onOpenFile={vi.fn()}
        onOpenUrl={vi.fn()}
      />,
    );
  });

  const noteBodies = () => renderer!.root.findAllByProps({ "data-thread-pin-note-body": true });
  expect(noteBodies()).toHaveLength(1);
  expect(
    renderer!.root.findAllByProps({ "data-note-markdown": "Agent one is running" }),
  ).toHaveLength(1);

  act(() => renderer!.root.findByProps({ "aria-label": "Collapse Delivery map" }).props.onClick());
  expect(noteBodies()).toHaveLength(0);
  expect(
    renderer!.root.findByProps({ "aria-label": "Expand Delivery map" }).props["aria-expanded"],
  ).toBe(false);

  act(() => {
    renderer?.unmount();
    renderer = create(
      <ThreadPinsContent
        threadRef={threadRef}
        pins={pins}
        onOpenFile={vi.fn()}
        onOpenUrl={vi.fn()}
      />,
    );
  });
  expect(noteBodies()).toHaveLength(0);
  expect(
    renderer!.root.findByProps({ "aria-label": "Expand Delivery map" }).props["aria-expanded"],
  ).toBe(false);

  act(() => renderer!.root.findByProps({ "aria-label": "Expand Delivery map" }).props.onClick());
  expect(noteBodies()).toHaveLength(1);
});
