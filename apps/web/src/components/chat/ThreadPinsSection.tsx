import type { ScopedThreadRef, ThreadPins } from "@t3tools/contracts";

import { useOpenLink } from "../../browser/useOpenLink";
import { useRightPanelStore } from "../../rightPanelStore";
import { ThreadPinsContent } from "../threadPins/ThreadPinsContent";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

/** True when a chat has a note or pins to show. */
export const hasThreadPins = (pins: ThreadPins | null): pins is ThreadPins =>
  pins !== null && (pins.note !== null || pins.pins.length > 0);

/**
 * Fork: thread details card section with the chat's note and pinned
 * artifacts, first in the card so they read at a glance when switching chats.
 */
export function ThreadPinsSection({
  threadRef,
  pins,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly pins: ThreadPins;
}) {
  const openLink = useOpenLink(threadRef);
  return (
    <ThreadDetailsSection headingId="thread-details-pins-heading" title="Pinned" separated={false}>
      <ThreadPinsContent
        threadRef={threadRef}
        pins={pins}
        onOpenFile={(path) => useRightPanelStore.getState().openFile(threadRef, path)}
        onOpenUrl={(url) => void openLink(url).catch(console.error)}
      />
    </ThreadDetailsSection>
  );
}
