import {
  isProviderNativeSubagentThread,
  type OrchestrationV2AppThread,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";

export type ThreadRelocationPlanResult =
  | {
      readonly ok: true;
      readonly updatedThreads: ReadonlyArray<OrchestrationV2AppThread>;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

function clearPullRequestWatch(link: ThreadPullRequestLink): ThreadPullRequestLink {
  const { watch: previous, endedWatch, ...rest } = link;
  const ended = previous ?? endedWatch;
  return ended === undefined ? rest : { ...rest, endedWatch: ended };
}

/**
 * Collect every proper descendant of `rootId` within `familyThreads` by following
 * `lineage.parentThreadId`. Guards against cycles with a visited set.
 */
function collectLineageDescendants(
  rootId: ThreadId,
  familyThreads: ReadonlyArray<OrchestrationV2AppThread>,
): ReadonlyArray<OrchestrationV2AppThread> {
  const childrenByParent = new Map<ThreadId, Array<OrchestrationV2AppThread>>();
  for (const candidate of familyThreads) {
    if (candidate.deletedAt !== null) continue;
    const parentId = candidate.lineage.parentThreadId;
    if (parentId === null) continue;
    const list = childrenByParent.get(parentId);
    if (list === undefined) childrenByParent.set(parentId, [candidate]);
    else list.push(candidate);
  }
  const visited = new Set<ThreadId>([rootId]);
  const descendants: Array<OrchestrationV2AppThread> = [];
  const queue: Array<ThreadId> = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of childrenByParent.get(current) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      descendants.push(child);
      queue.push(child.id);
    }
  }
  return descendants;
}

/**
 * Plans relocating `thread` under `parent` as a subagent, or moving it back to
 * top level when `parentThreadId` is `null`. Cascades `lineage.rootThreadId` to
 * every descendant in `familyThreads` so `getThreadFamily` stays consistent.
 */
export function planThreadRelocation(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly parentThreadId: ThreadId | null;
  readonly parent: OrchestrationV2AppThread | null;
  /** Ancestor IDs starting at `parent` and walking up `parentThreadId` to root. */
  readonly parentAncestorIds: ReadonlySet<ThreadId>;
  readonly familyThreads: ReadonlyArray<OrchestrationV2AppThread>;
}): ThreadRelocationPlanResult {
  const { thread, parentThreadId, parent, parentAncestorIds, familyThreads } = input;
  if (thread.deletedAt !== null) {
    return { ok: false, reason: `Thread ${thread.id} is deleted.` };
  }
  if (thread.archivedAt !== null) {
    return { ok: false, reason: "Archived threads cannot be relocated." };
  }
  if (isProviderNativeSubagentThread(thread)) {
    return { ok: false, reason: "Provider-native subagents cannot be relocated." };
  }
  if (thread.lineage.sideChat === true) {
    return { ok: false, reason: "Side chats cannot be relocated." };
  }
  if (thread.delegatedFrom != null) {
    return { ok: false, reason: "Remotely delegated threads cannot be relocated." };
  }
  if (thread.forkedFrom?.type === "node") {
    return { ok: false, reason: "Subagents created by task delegation cannot be relocated." };
  }

  let nextLineage: OrchestrationV2AppThread["lineage"];
  if (parentThreadId === null) {
    nextLineage = {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: thread.id,
    };
  } else {
    if (parentThreadId === thread.id) {
      return { ok: false, reason: "A thread cannot be relocated under itself." };
    }
    if (parent === null || parent.deletedAt !== null) {
      return { ok: false, reason: `Parent thread ${parentThreadId} was not found.` };
    }
    if (parent.archivedAt !== null) {
      return { ok: false, reason: "Cannot relocate a thread under an archived parent." };
    }
    if (isProviderNativeSubagentThread(parent)) {
      return { ok: false, reason: "Cannot relocate a thread under a provider-native subagent." };
    }
    if (parent.lineage.sideChat === true) {
      return { ok: false, reason: "Cannot relocate a thread under a side chat." };
    }
    if (parentAncestorIds.has(thread.id)) {
      return {
        ok: false,
        reason: "Cannot relocate a thread under one of its own descendants.",
      };
    }
    nextLineage = {
      parentThreadId: parent.id,
      relationshipToParent: "subagent",
      rootThreadId: parent.lineage.rootThreadId,
    };
  }

  const descendants = collectLineageDescendants(thread.id, familyThreads);
  const updatedDescendants = descendants
    .filter((descendant) => descendant.lineage.rootThreadId !== nextLineage.rootThreadId)
    .map((descendant): OrchestrationV2AppThread => ({
      ...descendant,
      lineage: {
        ...descendant.lineage,
        rootThreadId: nextLineage.rootThreadId,
      },
    }));

  const threadLineageUnchanged =
    thread.lineage.parentThreadId === nextLineage.parentThreadId &&
    thread.lineage.relationshipToParent === nextLineage.relationshipToParent &&
    thread.lineage.rootThreadId === nextLineage.rootThreadId;

  if (threadLineageUnchanged && updatedDescendants.length === 0) {
    return { ok: true, updatedThreads: [] };
  }

  const updatedThread: OrchestrationV2AppThread =
    parentThreadId === null
      ? {
          ...thread,
          lineage: nextLineage,
        }
      : {
          ...thread,
          lineage: nextLineage,
          // Subagents do not appear in top-level sidebar lists and must not watch PRs independently.
          pinnedAt: null,
          pinOrderKey: null,
          activeOrderKey: null,
          snoozedAt: null,
          snoozedUntil: null,
          ...(thread.pullRequests === undefined
            ? {}
            : { pullRequests: thread.pullRequests.map(clearPullRequestWatch) }),
        };

  return {
    ok: true,
    updatedThreads: [updatedThread, ...updatedDescendants],
  };
}
