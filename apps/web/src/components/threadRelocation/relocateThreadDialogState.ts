import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

/**
 * Threads currently open in the "Move under parent" picker dialog.
 * Context menus and the command palette close before the dialog mounts, so the
 * host mounted in `__root.tsx` renders it once.
 */
export const relocateThreadDialogTargetsAtom = Atom.make<ReadonlyArray<ScopedThreadRef> | null>(
  null,
).pipe(Atom.keepAlive, Atom.withLabel("fork:relocate-thread:dialog-targets"));

export function openRelocateThreadDialog(targets: ReadonlyArray<ScopedThreadRef>): void {
  if (targets.length === 0) return;
  appAtomRegistry.set(relocateThreadDialogTargetsAtom, targets);
}

export function closeRelocateThreadDialog(): void {
  appAtomRegistry.set(relocateThreadDialogTargetsAtom, null);
}
