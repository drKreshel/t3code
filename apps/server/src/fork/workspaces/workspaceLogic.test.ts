import { describe, expect, it } from "vite-plus/test";

import { planWorkspace, ticketBranch, unsavedWork } from "./workspaceLogic.ts";

const folder = { kind: "folder" as const, repos: ["app-fe", "api", "infra"] };

describe("planWorkspace", () => {
  it("gives a single-repo project a worktree and a folder nothing by default", () => {
    expect(planWorkspace({ kind: "repo", repos: [] }, [])).toEqual([
      { repo: ".", checkout: "worktree", startFrom: null },
    ]);
    expect(planWorkspace(folder, [])).toEqual([]);
    expect(planWorkspace({ kind: "none", repos: [] }, [])).toEqual([]);
  });

  it("layers project, board, and ticket rules field by field", () => {
    const project = { defaults: { startFrom: "origin/base" }, repos: [] };
    const board = {
      defaults: {},
      repos: [
        { repo: "app-fe", checkout: "worktree" as const, startFrom: "feature-deploy/atlas" },
        { repo: "api", checkout: "worktree" as const },
        { repo: "infra", checkout: "local" as const },
      ],
    };
    const ticket = { defaults: {}, repos: [{ repo: "api", startFrom: "rc" }] };
    expect(planWorkspace(folder, [project, board, ticket])).toEqual([
      { repo: "app-fe", checkout: "worktree", startFrom: "feature-deploy/atlas" },
      { repo: "api", checkout: "worktree", startFrom: "rc" },
      { repo: "infra", checkout: "local", startFrom: "origin/base" },
    ]);
  });

  it("lets a later layer's defaults override earlier per-repo settings", () => {
    const board = { defaults: {}, repos: [{ repo: "api", checkout: "worktree" as const }] };
    // A quick fix: everything in the main checkouts.
    const ticket = { defaults: { checkout: "local" as const }, repos: [] };
    expect(planWorkspace(folder, [undefined, board, ticket]).map((r) => r.checkout)).toEqual([
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
