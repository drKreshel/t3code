import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";

type FolderThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "archivedAt" | "deletedAt" | "settledOverride"
>;

/** Folder members come from the layout, including chats without a visible sidebar row. */
export function folderThreadSettlementTargets(
  threadKeys: readonly string[],
  settled: boolean,
  readShell: (ref: ScopedThreadRef) => FolderThread | null,
  supportsSettlement: (environmentId: EnvironmentId) => boolean,
  settledThreadKeys: ReadonlySet<string>,
): ScopedThreadRef[] {
  return threadKeys.flatMap((key) => {
    const ref = parseScopedThreadKey(key);
    const shell = ref === null ? null : readShell(ref);
    if (
      ref === null ||
      shell === null ||
      shell.archivedAt !== null ||
      shell.deletedAt !== null ||
      !supportsSettlement(shell.environmentId)
    )
      return [];
    return (
      settled
        ? shell.settledOverride !== "settled"
        : shell.settledOverride === "settled" || settledThreadKeys.has(key)
    )
      ? [ref]
      : [];
  });
}
