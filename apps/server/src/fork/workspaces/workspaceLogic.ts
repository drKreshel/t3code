/** Pure pieces of ticket workspaces: resolving layered rules and naming things. */
import type { ProjectRepos, WorkspaceCheckout, WorkspaceRules } from "@t3tools/contracts";

export interface PlannedRepo {
  readonly repo: string;
  readonly checkout: "worktree" | "local";
  /** Null: the repo's remote default branch. */
  readonly startFrom: string | null;
}

/**
 * The repos a ticket's workspace holds, with their checkout and start branch.
 * Layers apply in order (project, board, ticket): a layer's defaults apply to
 * every repo, then its per-repo rules; a later layer overrides an earlier one
 * field by field.
 *
 * Without rules, a single-repo project gets a worktree and a folder of repos
 * gets nothing: a folder can hold many repos, and a ticket should only carry
 * the ones it works on.
 */
export function planWorkspace(
  project: ProjectRepos,
  layers: ReadonlyArray<Pick<WorkspaceRules, "defaults" | "repos"> | undefined>,
): PlannedRepo[] {
  if (project.kind === "none") return [];
  const repos = project.kind === "repo" ? ["."] : project.repos;
  let defaultCheckout: WorkspaceCheckout = project.kind === "repo" ? "worktree" : "skip";
  let defaultStartFrom: string | undefined;
  const perRepo = new Map<string, { checkout?: WorkspaceCheckout; startFrom?: string }>();
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.defaults.checkout !== undefined) {
      defaultCheckout = layer.defaults.checkout;
      // A layer's default overrides earlier layers' per-repo checkouts too.
      for (const entry of perRepo.values()) delete entry.checkout;
    }
    if (layer.defaults.startFrom !== undefined) {
      defaultStartFrom = layer.defaults.startFrom;
      for (const entry of perRepo.values()) delete entry.startFrom;
    }
    for (const rule of layer.repos) {
      const entry = perRepo.get(rule.repo) ?? {};
      if (rule.checkout !== undefined) entry.checkout = rule.checkout;
      if (rule.startFrom !== undefined) entry.startFrom = rule.startFrom;
      perRepo.set(rule.repo, entry);
    }
  }
  return repos.flatMap((repo) => {
    const entry = perRepo.get(repo);
    const checkout = entry?.checkout ?? defaultCheckout;
    if (checkout === "skip") return [];
    return [{ repo, checkout, startFrom: entry?.startFrom ?? defaultStartFrom ?? null }];
  });
}

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
