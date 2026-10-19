interface AgentInput {
  readonly runtimeTabId: string;
  readonly order: number;
  previous: Element | null;
}

// Agent input can overlap across tabs and threads.
const inFlightInputs = new Set<AgentInput>();
let nextInputOrder = 0;

const focusedPreviewTab = (element: Element | null): string | null =>
  element?.localName === "webview" ? element.getAttribute("data-preview-tab") : null;

const restoreHostFocus = ({ runtimeTabId, previous }: AgentInput): void => {
  const current = document.activeElement;
  if (
    !(current instanceof HTMLElement) ||
    current === previous ||
    focusedPreviewTab(current) !== runtimeTabId
  ) {
    return;
  }
  if (previous instanceof HTMLElement && previous.isConnected && previous !== document.body) {
    previous.focus({ preventScroll: true });
  }
  // The previous element may no longer take focus, like a composer that was
  // disabled meanwhile. Never leave focus in the page.
  if (document.activeElement === current) current.blur();
};

/**
 * Marks agent input that can focus a preview tab's page, and returns the call
 * that hands keyboard focus back to the host page once that input ends.
 *
 * The desktop runs agent clicks as CDP mouse presses and agent typing through
 * page script that calls focus(); both move window focus into the guest page,
 * and nothing gives it back. The user's next keystrokes then go into the page,
 * even when its tab is hidden or belongs to another thread. Only the host
 * document knows what had focus before, so the restore happens here and not
 * in the desktop main process.
 */
export function holdPreviewHostFocus(runtimeTabId: string): () => void {
  const entry: AgentInput = {
    runtimeTabId,
    order: nextInputOrder++,
    previous: document.activeElement,
  };
  inFlightInputs.add(entry);
  return () => {
    if (!inFlightInputs.delete(entry)) return;
    // Input that started while this one held focus in its page saw that page
    // as what had focus. Hand it this input's target instead. Input that never
    // ends never gets here, so it cannot override where the user goes later.
    for (const other of inFlightInputs) {
      if (other.order > entry.order && focusedPreviewTab(other.previous) === runtimeTabId) {
        other.previous = entry.previous;
      }
    }
    restoreHostFocus(entry);
  };
}
