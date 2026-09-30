/** Pure pieces of ticket workspaces: resolving layered rules and naming things. */
export { planWorkspace, type PlannedRepo } from "@t3tools/contracts";

/** `ST-12` → `st-12`: the workspace folder name. */
export function ticketSlug(ticketKey: string): string {
  return ticketKey.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/** `ST-12` → `ticket/st-12`: the branch every worktree of the ticket uses. */
export function ticketBranch(ticketKey: string): string {
  return `ticket/${ticketSlug(ticketKey)}`;
}

/** A folder name safe to use for a project on disk. */
export function safeFolderName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "-") || "project";
}

/** Whether a worktree holds work that would be lost by removing it. */
export function unsavedWork(status: {
  readonly hasWorkingTreeChanges: boolean;
  readonly hasUpstream: boolean;
  readonly aheadCount: number;
  readonly aheadOfDefaultCount?: number | undefined;
}): string | null {
  if (status.hasWorkingTreeChanges) return "uncommitted changes";
  if (status.hasUpstream && status.aheadCount > 0) {
    return `${status.aheadCount} unpushed commit${status.aheadCount === 1 ? "" : "s"}`;
  }
  // Never pushed: commits beyond the default branch exist nowhere else.
  if (!status.hasUpstream && (status.aheadOfDefaultCount ?? 0) > 0) {
    return "commits that were never pushed";
  }
  return null;
}
