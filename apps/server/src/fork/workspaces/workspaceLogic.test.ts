import { describe, expect, it } from "vite-plus/test";

import { planWorkspace, ticketBranch, unsavedWork } from "./workspaceLogic.ts";

const folder = {
  kind: "folder" as const,
  repos: ["app-fe", "api", "infra"],
  workspace: "local" as const,
};
const repo = (workspace: "local" | "worktree") => ({ kind: "repo" as const, repos: [], workspace });

describe("planWorkspace", () => {
  it("follows a single repo's Workspace setting and gives a folder nothing by default", () => {
    expect(planWorkspace(repo("worktree"), [])).toEqual([
      { repo: ".", checkout: "worktree", startFrom: null },
    ]);
    expect(planWorkspace(repo("local"), [])).toEqual([
      { repo: ".", checkout: "local", startFrom: null },
    ]);
    expect(planWorkspace({ ...folder, workspace: "worktree" }, [])).toEqual([]);
    expect(planWorkspace({ kind: "none", repos: [], workspace: "worktree" }, [])).toEqual([]);
  });

  it("layers board and ticket rules field by field", () => {
    const board = {
      defaults: { startFrom: "origin/base" },
      repos: [
        { repo: "app-fe", checkout: "worktree" as const, startFrom: "feature-deploy/atlas" },
        { repo: "api", checkout: "worktree" as const },
        { repo: "infra", checkout: "local" as const },
      ],
    };
    const ticket = { defaults: {}, repos: [{ repo: "api", startFrom: "rc" }] };
    expect(planWorkspace(folder, [board, ticket])).toEqual([
      { repo: "app-fe", checkout: "worktree", startFrom: "feature-deploy/atlas" },
      { repo: "api", checkout: "worktree", startFrom: "rc" },
      { repo: "infra", checkout: "local", startFrom: "origin/base" },
    ]);
  });

  it("lets a later layer's defaults override earlier per-repo settings", () => {
    const board = { defaults: {}, repos: [{ repo: "api", checkout: "worktree" as const }] };
    // A quick fix: everything in the main checkouts.
    const ticket = { defaults: { checkout: "local" as const }, repos: [] };
    expect(planWorkspace(folder, [board, ticket]).map((r) => r.checkout)).toEqual([
      "local",
      "local",
      "local",
    ]);
  });
});

describe("unsavedWork", () => {
  it("reports work that removing the worktree would lose", () => {
    const clean = { hasWorkingTreeChanges: false, hasUpstream: true, aheadCount: 0 };
    expect(unsavedWork(clean)).toBeNull();
    expect(unsavedWork({ ...clean, hasWorkingTreeChanges: true })).toBe("uncommitted changes");
    expect(unsavedWork({ ...clean, aheadCount: 2 })).toBe("2 unpushed commits");
    expect(unsavedWork({ ...clean, hasUpstream: false, aheadOfDefaultCount: 1 })).toBe(
      "commits that were never pushed",
    );
  });
});

describe("ticketBranch", () => {
  it("names the branch after the ticket key", () => {
    expect(ticketBranch("ATLAS-12")).toBe("ticket/atlas-12");
  });
});
