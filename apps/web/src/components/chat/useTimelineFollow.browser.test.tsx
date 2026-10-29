import { EnvironmentId, MessageId, RunId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { type ComponentProps, useRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { act, render } from "../../../test/render";
import { MessagesTimeline } from "./MessagesTimeline";
import { useTimelineFollow } from "./useTimelineFollow";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-03-17T19:12:28.000Z";
const RUN_ID = RunId.make("run-1");
const SENT_MESSAGE_ID = MessageId.make("sent");

type Entry = ComponentProps<typeof MessagesTimeline>["timelineEntries"][number];

function message(id: string, role: "user" | "assistant", streaming = false): Entry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role,
      text: `${id}\n\n${"lorem ipsum ".repeat(80)}`,
      runId: role === "assistant" ? RUN_ID : null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming,
    },
  };
}

function runningTool(): Entry {
  return {
    id: "entry-tool",
    kind: "work",
    createdAt: CREATED_AT,
    entry: {
      id: "tool",
      createdAt: CREATED_AT,
      runId: RUN_ID,
      label: "Ran tests",
      command: "vp test",
      tone: "tool",
      toolLifecycleStatus: "inProgress",
    },
  };
}

function FollowedTimeline({
  routeThreadKey,
  entries,
  sentMessageId,
  onReport,
}: {
  routeThreadKey: string;
  entries: Entry[];
  sentMessageId?: MessageId;
  onReport: () => void;
}) {
  const legendListRef = useRef<LegendListRef | null>(null);
  const [timelineAnchor, setTimelineAnchor] = useState<{
    threadKey: string | null;
    messageId: MessageId | null;
  }>({ threadKey: null, messageId: null });
  const follow = useTimelineFollow({
    legendListRef,
    composerTimelineInset: 0,
    routeThreadKey,
    activeThreadKey: routeThreadKey,
    isServerThread: false,
    serverProjection: null,
    threadStatus: "live",
    activeActivityRun: null,
    activeRunningTurnId: null,
    timelineEntries: entries,
    timelineAnchorMessageId: timelineAnchor.messageId,
    setTimelineAnchor,
  });
  const [anchoredSend, setAnchoredSend] = useState<MessageId | undefined>(undefined);
  if (sentMessageId !== anchoredSend) {
    setAnchoredSend(sentMessageId);
    if (sentMessageId) follow.anchorNewTurn(routeThreadKey, sentMessageId);
  }
  return (
    <div
      data-testid="followed-timeline"
      data-following={String(follow.timelineLiveFollowEnabled)}
      style={{ height: "100%" }}
    >
      <MessagesTimeline
        isWorking
        listRef={legendListRef}
        latestRun={null}
        turnDiffSummaries={[]}
        runs={[]}
        routeThreadKey={routeThreadKey}
        onOpenTurnDiff={() => {}}
        onOpenThread={() => {}}
        onForkFromRun={async () => {}}
        supportsConversationRollback={false}
        onRevertToTurnCount={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        activeThreadEnvironmentId={ENVIRONMENT_ID}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        anchorMessageId={timelineAnchor.messageId}
        onAnchorReady={follow.onTimelineAnchorReadyStable}
        onAnchorSizeChanged={follow.onTimelineAnchorSizeChangedStable}
        contentInsetEndAdjustment={0}
        emptyPlaceholderInset={0}
        liveFollowEnabled={follow.timelineLiveFollowEnabled}
        onIsAtEndChange={(isAtEnd) => {
          follow.onIsAtEndChangeStable(isAtEnd);
          onReport();
        }}
        onViewportAttach={follow.attachTimelineViewport}
        onFooterGrow={follow.onTimelineFooterGrowStable}
        timelineEntries={entries}
      />
    </div>
  );
}

describe("useTimelineFollow", () => {
  it("keeps a reader of history in place when rows change under them, until they scroll back to the end", async () => {
    const routeThreadKey = `environment-local:thread-${Math.random().toString(36).slice(2)}`;
    const history = Array.from({ length: 19 }, (_, index) =>
      message(`message-${index}`, index % 2 === 0 ? "user" : "assistant"),
    );
    const sent = [...history, message(SENT_MESSAGE_ID, "user")];
    const turn = [...sent, message("reply", "assistant", true), runningTool()];
    // The list reports its end position after each scroll and each layout.
    let reports = 0;
    const onReport = () => {
      reports += 1;
    };
    const container = document.createElement("div");
    container.style.cssText = "height: 800px; width: 900px; display: flex; flex-direction: column;";
    await using screen = await render(
      <FollowedTimeline routeThreadKey={routeThreadKey} entries={history} onReport={onReport} />,
      { container },
    );
    const show = async (entries: Entry[]) => {
      const before = reports;
      await screen.rerender(
        <FollowedTimeline
          routeThreadKey={routeThreadKey}
          entries={entries}
          sentMessageId={SENT_MESSAGE_ID}
          onReport={onReport}
        />,
      );
      await vi.waitFor(() => expect(reports).toBeGreaterThan(before));
      // Commits the follow change that report dispatched.
      await act(() => {});
    };
    const timeline = screen.getByTestId("followed-timeline");
    const viewport = await vi.waitFor(() => {
      const node = container.querySelector<HTMLElement>(".messages-timeline-scroll");
      expect(node).not.toBeNull();
      return node!;
    });
    await show(sent);
    await show(turn);
    await vi.waitFor(() => {
      expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight * 2);
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeLessThan(2);
    });

    await act(() => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
      viewport.scrollTop -= 150;
    });
    await expect.element(timeline).toHaveAttribute("data-following", "false");

    // Re-keyed rows lay out from estimated sizes, so the end briefly comes
    // into view without the reader scrolling.
    await show(turn.map((entry) => ({ ...entry, id: `${entry.id}-projected` })));
    expect(timeline.element().getAttribute("data-following")).toBe("false");

    await act(() => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true }));
      viewport.scrollTop = viewport.scrollHeight;
    });
    await expect.element(timeline).toHaveAttribute("data-following", "true");
  });
});
