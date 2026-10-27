import type {
  EnvironmentId,
  PullRequestLinkedThreadsResult,
  ScopedProjectRef,
} from "@t3tools/contracts";

import {
  dispatchCommandPalette,
  isCommandPaletteMounted,
  useCommandPaletteStore,
} from "./commandPaletteStore";

export interface CommandPaletteLinkedThreads {
  readonly environmentId: EnvironmentId;
  readonly threads: PullRequestLinkedThreadsResult["threads"];
}

export interface CommandPaletteOpenDetail {
  readonly open?: "add-project" | "new-thread-in";
  readonly query?: string;
  readonly linkedThreads?: CommandPaletteLinkedThreads;
  /** With "new-thread-in": receive the picked project instead of the palette
      starting the thread itself. One-shot; closing the palette drops it. */
  readonly onPickProject?: (projectRef: ScopedProjectRef) => void;
}

let pendingProjectPick: ((projectRef: ScopedProjectRef) => void) | null = null;

/** Takes the caller's project handler for this "new-thread-in" pick, if any. */
export function takePendingProjectPick(): ((projectRef: ScopedProjectRef) => void) | null {
  const pick = pendingProjectPick;
  pendingProjectPick = null;
  return pick;
}

useCommandPaletteStore.subscribe((state) => {
  if (!state.open) pendingProjectPick = null;
});

export function openCommandPalette(detail: CommandPaletteOpenDetail = {}): void {
  // With no palette on screen (e.g. /pair) the request is dropped; kept in the
  // store, it would pop a stale palette once the app shell mounts.
  if (!isCommandPaletteMounted()) return;
  pendingProjectPick = detail.onPickProject ?? null;
  if (detail.open === "new-thread-in") {
    dispatchCommandPalette({ _tag: "OpenNewThreadIn" });
  } else if (detail.open === "add-project") {
    dispatchCommandPalette({ _tag: "OpenAddProject" });
  } else if (detail.query !== undefined) {
    dispatchCommandPalette({
      _tag: "OpenSearch",
      query: detail.query,
      ...(detail.linkedThreads ? { linkedThreads: detail.linkedThreads } : {}),
    });
  } else {
    dispatchCommandPalette({ _tag: "SetOpen", open: true });
  }
}

/** True while the palette popup is on screen, including its closing animation. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}
