import type { ScopedThreadRef, ThreadPins } from "@t3tools/contracts";

import { useOpenLink } from "../../browser/useOpenLink";
import { useRightPanelStore } from "../../rightPanelStore";
import { ThreadPinsContent } from "../threadPins/ThreadPinsContent";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

/** True when a chat has pins to show. */
export const hasThreadPins = (pins: ThreadPins | null): pins is ThreadPins =>
  pins !== null && pins.pins.length > 0;

/**
 * Fork: thread details card section with the chat's pinned files, URLs, and
 * notes, last in the card so the controls above keep their place.
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
    <ThreadDetailsSection headingId="thread-details-pins-heading" title="Pinned">
      <ThreadPinsContent
        threadRef={threadRef}
        pins={pins}
        onOpenFile={(path) => useRightPanelStore.getState().openFile(threadRef, path)}
        onOpenUrl={(url) => void openLink(url).catch(console.error)}
      />
    </ThreadDetailsSection>
  );
}
