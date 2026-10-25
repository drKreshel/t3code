import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { type ComponentProps, useRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { act, fakeTimers, render } from "../../../test/render";
import type { ChatComposerHandle } from "./ChatComposer";
import { MessagesTimeline } from "./MessagesTimeline";
import { readTimelinePosition } from "./timelineScrollAnchoring";
import { useTimelineFollow } from "./useTimelineFollow";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_ID = ThreadId.make("thread-follow");
const CREATED_AT = "2026-03-17T19:12:28.000Z";

type Entry = ComponentProps<typeof MessagesTimeline>["timelineEntries"][number];

function message(id: string, role: "user" | "assistant"): Entry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role,
      text: `${id}\n\n${"lorem ipsum ".repeat(80)}`,
      runId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming: false,
    },
  };
}

function FollowedTimeline({
  routeThreadKey,
  entries,
}: {
  routeThreadKey: string;
  entries: Entry[];
}) {
  const legendListRef = useRef<LegendListRef | null>(null);
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const [timelineAnchor, setTimelineAnchor] = useState<{
    threadKey: string | null;
    messageId: MessageId | null;
  }>({ threadKey: null, messageId: null });
  const follow = useTimelineFollow({
    legendListRef,
    composerRef,
    composerOverlayElement: null,
    composerTimelineInset: 0,
    routeThreadKey,
    activeThreadKey: routeThreadKey,
    activeThreadId: THREAD_ID,
    isServerThread: false,
    serverProjection: null,
    threadStatus: "live",
    activeActivityRun: null,
    activeRunningTurnId: null,
    timelineEntries: entries,
    timelineAnchorMessageId: timelineAnchor.messageId,
    setTimelineAnchor,
  });
  return (
    <div
      data-testid="followed-timeline"
      data-following={String(follow.timelineLiveFollowEnabled)}
      style={{ height: "100%" }}
    >
      <MessagesTimeline
        isWorking={entries.length > 0}
        activeTurnInProgress={entries.length > 0}
        listRef={legendListRef}
        latestRun={null}
        turnDiffSummaries={[]}
        runs={[]}
        routeThreadKey={routeThreadKey}
        onOpenTurnDiff={() => {}}
        onOpenThread={() => {}}
        onForkFromRun={async () => {}}
        onRollbackCheckpoint={() => {}}
        supportsConversationRollback={false}
        onRevertToTurnCount={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        activeThreadEnvironmentId={ENVIRONMENT_ID}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        anchorMessageId={null}
        onAnchorReady={follow.onTimelineAnchorReadyStable}
        onAnchorSizeChanged={follow.onTimelineAnchorSizeChangedStable}
        contentInsetEndAdjustment={0}
        emptyPlaceholderInset={0}
        liveFollowEnabled={follow.timelineLiveFollowEnabled}
        onIsAtEndChange={follow.onIsAtEndChangeStable}
        onManualNavigation={follow.cancelTimelineLiveFollowForUserNavigationStable}
        cancelPositionRestoreRef={follow.cancelPositionRestoreRef}
        timelineEntries={entries}
      />
    </div>
  );
}

// A loading or empty thread renders no list, so its scroll node appears many
// frames after the thread opened.
async function renderBeforeListMounts(routeThreadKey: string, container: HTMLElement) {
  await using stack = new AsyncDisposableStack();
  using _timers = fakeTimers();
  const screen = stack.use(
    await render(<FollowedTimeline routeThreadKey={routeThreadKey} entries={[]} />, {
      container,
    }),
  );
  await act(() => {
    for (let frame = 0; frame < 30; frame++) vi.advanceTimersToNextFrame();
  });
  stack.move();
  return screen;
}

describe("useTimelineFollow", () => {
  it("lets the user scroll away from a list that mounted after the thread opened", async () => {
    const routeThreadKey = `environment-local:thread-${Math.random().toString(36).slice(2)}`;
    const entries = Array.from({ length: 20 }, (_, index) =>
      message(`message-${index}`, index % 2 === 0 ? "user" : "assistant"),
    );
    const container = document.createElement("div");
    container.style.cssText = "height: 800px; width: 900px; display: flex; flex-direction: column;";
    await using screen = await renderBeforeListMounts(routeThreadKey, container);

    await screen.rerender(<FollowedTimeline routeThreadKey={routeThreadKey} entries={entries} />);
    const timeline = screen.getByTestId("followed-timeline");
    const viewport = await vi.waitFor(() => {
      const node = container.querySelector<HTMLElement>(".messages-timeline-scroll");
      expect(node).not.toBeNull();
      expect(node!.scrollHeight).toBeGreaterThan(node!.clientHeight * 2);
      return node!;
    });
    // Opening restore listens for its own cancel gestures until the list settles,
    // which it marks by remembering the position.
    await vi.waitFor(async () => {
      await act(() => viewport.dispatchEvent(new Event("scroll")));
      expect(readTimelinePosition(routeThreadKey)?.atEnd).toBe(true);
    });
    await expect.element(timeline).toHaveAttribute("data-following", "true");

    await act(() => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
      viewport.scrollTop -= 600;
    });

    await expect.element(timeline).toHaveAttribute("data-following", "false");
  });
});
