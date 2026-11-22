import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, NodeId, ProjectId, ThreadId } from "@t3tools/contracts";

import {
  canMoveThreadToTopLevel,
  canRelocateThread,
  rankRelocationParentCandidates,
  type RelocatableThreadCandidate,
} from "./relocateThreadLogic";

const ENV_1 = EnvironmentId.make("env-1");
const ENV_2 = EnvironmentId.make("env-2");
const PROJ_1 = ProjectId.make("proj-1");
const PROJ_2 = ProjectId.make("proj-2");

function makeCandidate(
  id: string,
  overrides: Partial<RelocatableThreadCandidate> = {},
): RelocatableThreadCandidate {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    environmentId: ENV_1,
    projectId: PROJ_1,
    title: `Chat ${id}`,
    branch: null,
    archivedAt: null,
    source: { creationSource: "web" },
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    delegatedFrom: null,
    forkedFrom: null,
    settledOverride: null,
    settledAt: null,
    updatedAt: "2026-11-22T12:00:00.000Z",
    ...overrides,
  };
}

describe("relocateThreadLogic", () => {
  it("allows relocating regular chats and relocated subagents, and blocks native/delegated/side/archived chats", () => {
    const parent = makeCandidate("parent");
    const relocatedSubagent = makeCandidate("sub", {
      lineage: {
        parentThreadId: parent.id,
        relationshipToParent: "subagent",
        rootThreadId: parent.id,
      },
    });
    const nativeSubagent = makeCandidate("native", {
      source: { creationSource: "provider" },
      lineage: {
        parentThreadId: parent.id,
        relationshipToParent: "subagent",
        rootThreadId: parent.id,
      },
    });
    const delegatedSubagent = makeCandidate("delegated", {
      forkedFrom: { type: "node", nodeId: NodeId.make("n1") },
      lineage: {
        parentThreadId: parent.id,
        relationshipToParent: "subagent",
        rootThreadId: parent.id,
      },
    });

    expect(canRelocateThread(parent)).toBe(true);
    expect(canMoveThreadToTopLevel(parent)).toBe(false);
    expect(canRelocateThread(relocatedSubagent)).toBe(true);
    expect(canMoveThreadToTopLevel(relocatedSubagent)).toBe(true);
    expect(canRelocateThread(nativeSubagent)).toBe(false);
    expect(canRelocateThread(delegatedSubagent)).toBe(false);
    expect(
      canRelocateThread(
        makeCandidate("archived", {
          archivedAt: "2026-11-22T12:00:00.000Z",
        }),
      ),
    ).toBe(false);
  });

  it("excludes target, descendants, other environments, archived, and side chats; ranks same-project listed threads first", () => {
    const target = makeCandidate("target");
    const childOfTarget = makeCandidate("child-of-target", {
      lineage: {
        parentThreadId: target.id,
        relationshipToParent: "subagent",
        rootThreadId: target.id,
      },
    });
    const grandchildOfTarget = makeCandidate("grandchild-of-target", {
      lineage: {
        parentThreadId: childOfTarget.id,
        relationshipToParent: "subagent",
        rootThreadId: target.id,
      },
    });
    const sameProjectActive = makeCandidate("same-active", {
      updatedAt: "2026-11-22T12:05:00.000Z",
    });
    const sameProjectSettled = makeCandidate("same-settled", {
      settledOverride: "settled",
      updatedAt: "2026-11-22T12:10:00.000Z",
    });
    const otherProjectActive = makeCandidate("other-active", {
      projectId: PROJ_2,
      updatedAt: "2026-11-22T12:15:00.000Z",
    });
    const otherEnv = makeCandidate("other-env", { environmentId: ENV_2 });
    const sideChat = makeCandidate("side-chat", {
      lineage: {
        parentThreadId: sameProjectActive.id,
        relationshipToParent: "fork",
        rootThreadId: sameProjectActive.id,
        sideChat: true,
      },
    });

    const ranked = rankRelocationParentCandidates({
      targets: [target],
      allThreads: [
        target,
        childOfTarget,
        grandchildOfTarget,
        otherProjectActive,
        sameProjectSettled,
        sameProjectActive,
        otherEnv,
        sideChat,
      ],
      projectsByKey: new Map(),
      query: "",
    });

    expect(ranked.map((entry) => entry.thread.id)).toEqual([
      sameProjectActive.id,
      sameProjectSettled.id,
      otherProjectActive.id,
    ]);
  });

  it("filters candidates by search query across title and branch", () => {
    const target = makeCandidate("target");
    const alpha = makeCandidate("alpha", { title: "Alpha Coordinator", branch: "feat/alpha" });
    const beta = makeCandidate("beta", { title: "Beta Work", branch: "fix/beta-bug" });

    const ranked = rankRelocationParentCandidates({
      targets: [target],
      allThreads: [target, alpha, beta],
      projectsByKey: new Map(),
      query: "beta-bug",
    });

    expect(ranked.map((entry) => entry.thread.id)).toEqual([beta.id]);
  });
});
