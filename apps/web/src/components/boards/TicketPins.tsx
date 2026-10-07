import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { useOpenLink } from "../../browser/useOpenLink";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadPins } from "../../state/threadPins";
import { hasThreadPins } from "../chat/ThreadPinsSection";
import { ThreadPinsContent } from "../threadPins/ThreadPinsContent";

/**
 * Fork: the notes and pinned artifacts of every chat on a ticket, one block
 * per chat that has any. Pins belong to chats; the ticket only collects them.
 */
export function TicketPins({ threads }: { readonly threads: readonly EnvironmentThreadShell[] }) {
  return threads.map((thread) => (
    <TicketThreadPins
      key={`${thread.environmentId}:${thread.id}`}
      thread={thread}
      showTitle={threads.length > 1}
    />
  ));
}

function TicketThreadPins({
  thread,
  showTitle,
}: {
  readonly thread: EnvironmentThreadShell;
  readonly showTitle: boolean;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const pins = useThreadPins(threadRef);
  const navigate = useNavigate();
  // Without a chat beside it there is no in-app tab, so URLs go to the system browser.
  const openLink = useOpenLink(null);
  if (!hasThreadPins(pins)) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="truncate text-xs text-muted-foreground">
        {showTitle ? `Pinned · ${thread.title}` : "Pinned"}
      </span>
      <div className="-mx-2.5">
        <ThreadPinsContent
          threadRef={threadRef}
          pins={pins}
          onOpenFile={(path) => {
            // Files open in the chat's own panel, beside the work that made them.
            useRightPanelStore.getState().openFile(threadRef, path);
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: thread.environmentId, threadId: thread.id },
            });
          }}
          onOpenUrl={(url) => void openLink(url).catch(console.error)}
        />
      </div>
    </div>
  );
}
