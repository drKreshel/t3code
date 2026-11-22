import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isListedThreadLineage,
  isProviderNativeSubagentThread,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";

export type RelocatableThreadShape = Pick<
  EnvironmentThreadShell,
  "archivedAt" | "lineage" | "delegatedFrom" | "forkedFrom"
> & {
  readonly source?: Pick<OrchestrationV2ThreadShell, "creationSource"> | undefined;
};

export type RelocatableThreadCandidate = Pick<
  EnvironmentThreadShell,
  | "id"
  | "environmentId"
  | "projectId"
  | "title"
  | "branch"
  | "archivedAt"
  | "lineage"
  | "delegatedFrom"
  | "forkedFrom"
  | "settledOverride"
  | "settledAt"
  | "updatedAt"
> & {
  readonly source?: Pick<OrchestrationV2ThreadShell, "creationSource"> | undefined;
};

function isNativeSubagent(thread: RelocatableThreadShape): boolean {
  const creationSource = thread.source?.creationSource;
  if (creationSource === undefined) return false;
  return isProviderNativeSubagentThread({ lineage: thread.lineage, creationSource });
}

/** Mirrors server validation in `apps/server/src/fork/threadRelocation.ts`. */
export function canRelocateThread(thread: RelocatableThreadShape): boolean {
  return (
    thread.archivedAt === null &&
    !isNativeSubagent(thread) &&
    thread.lineage.sideChat !== true &&
    thread.delegatedFrom == null &&
    thread.forkedFrom?.type !== "node"
  );
}

export function canMoveThreadToTopLevel(thread: RelocatableThreadShape): boolean {
  return canRelocateThread(thread) && thread.lineage.relationshipToParent === "subagent";
}

function collectDescendantIds(
  rootIds: ReadonlySet<ThreadId>,
  threads: ReadonlyArray<Pick<EnvironmentThreadShell, "id" | "lineage">>,
): ReadonlySet<ThreadId> {
  const childrenByParent = new Map<ThreadId, Array<ThreadId>>();
  for (const thread of threads) {
    const parentId = thread.lineage.parentThreadId;
    if (parentId === null) continue;
    const list = childrenByParent.get(parentId);
    if (list === undefined) childrenByParent.set(parentId, [thread.id]);
    else list.push(thread.id);
  }
  const visited = new Set<ThreadId>(rootIds);
  const queue = [...rootIds];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const childId of childrenByParent.get(current) ?? []) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      queue.push(childId);
    }
  }
  return visited;
}

export interface RankedParentCandidate {
  readonly thread: RelocatableThreadCandidate;
  readonly project: EnvironmentProject | null;
  readonly isCurrentParent: boolean;
  readonly isSameProject: boolean;
  readonly isSubagent: boolean;
  readonly isSettled: boolean;
}

function updatedAtMillis(value: string): number {
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : 0;
}

export function rankRelocationParentCandidates(input: {
  readonly targets: ReadonlyArray<RelocatableThreadCandidate>;
  readonly allThreads: ReadonlyArray<RelocatableThreadCandidate>;
  readonly projectsByKey: ReadonlyMap<string, EnvironmentProject>;
  readonly query: string;
}): ReadonlyArray<RankedParentCandidate> {
  if (input.targets.length === 0) return [];
  const environmentId = input.targets[0]!.environmentId;
  const envThreads = input.allThreads.filter((thread) => thread.environmentId === environmentId);
  const targetIds = new Set<ThreadId>(input.targets.map((target) => target.id));
  const forbiddenIds = collectDescendantIds(targetIds, envThreads);

  const uniqueTargetProjects = new Set(input.targets.map((target) => target.projectId));
  const sharedProjectId = uniqueTargetProjects.size === 1 ? input.targets[0]!.projectId : null;

  const uniqueCurrentParents = new Set(
    input.targets.map((target) =>
      target.lineage.relationshipToParent === "subagent" ? target.lineage.parentThreadId : null,
    ),
  );
  const soleCurrentParentId =
    uniqueCurrentParents.size === 1 ? ([...uniqueCurrentParents][0] ?? null) : null;

  const needle = input.query.trim().toLowerCase();
  const candidates: Array<RankedParentCandidate> = [];

  for (const candidate of envThreads) {
    if (forbiddenIds.has(candidate.id)) continue;
    if (candidate.archivedAt !== null) continue;
    if (isNativeSubagent(candidate)) continue;
    if (candidate.lineage.sideChat === true) continue;

    const project =
      input.projectsByKey.get(`${candidate.environmentId}:${candidate.projectId}`) ?? null;
    if (needle.length > 0) {
      const haystack = [candidate.title, project?.title ?? "", candidate.branch ?? "", candidate.id]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) continue;
    }

    candidates.push({
      thread: candidate,
      project,
      isCurrentParent: soleCurrentParentId !== null && candidate.id === soleCurrentParentId,
      isSameProject: sharedProjectId !== null && candidate.projectId === sharedProjectId,
      isSubagent: !isListedThreadLineage(candidate.lineage),
      isSettled: candidate.settledOverride === "settled" || candidate.settledAt !== null,
    });
  }

  candidates.sort((left, right) => {
    if (left.isSameProject !== right.isSameProject) return left.isSameProject ? -1 : 1;
    if (left.isSubagent !== right.isSubagent) return left.isSubagent ? 1 : -1;
    if (left.isSettled !== right.isSettled) return left.isSettled ? 1 : -1;
    const timeDelta =
      updatedAtMillis(right.thread.updatedAt) - updatedAtMillis(left.thread.updatedAt);
    if (timeDelta !== 0) return timeDelta;
    return left.thread.id < right.thread.id ? -1 : left.thread.id > right.thread.id ? 1 : 0;
  });

  return candidates;
}
