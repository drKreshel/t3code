import { it as itEffect } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { planThreadRelocation } from "./threadRelocation.ts";

const NOW = DateTime.makeUnsafe("2026-11-22T12:00:00.000Z");

function makeThread(
  id: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread {
  const threadId = ThreadId.make(id);
  const base: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: `Thread ${id}`,
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    forkedFrom: null,
    lastVisitedAt: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    settledOverride: null,
    settledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    deletedAt: null,
  };
  return { ...base, ...overrides };
}

describe("planThreadRelocation", () => {
  it("relocates a top-level thread under a parent as a subagent and clears sidebar state and PR watches", () => {
    const parent = makeThread("parent");
    const child = makeThread("child", {
      pinnedAt: NOW,
      pinOrderKey: "a0",
      activeOrderKey: "b0",
      snoozedAt: NOW,
      snoozedUntil: NOW,
      pullRequests: [
        {
          host: "github.com",
          repository: "org/repo",
          number: 42,
          url: "https://github.com/org/repo/pull/42",
          source: "manual",
          linkedAt: "2026-11-22T12:00:00.000Z",
          snapshot: null,
          stack: null,
          watch: {
            startedAt: "2026-11-22T12:00:00.000Z",
            headSha: "abc123",
            failedChecks: [],
            passed: false,
            passedChecks: [],
            remarksThrough: "2026-11-22T12:00:00.000Z",
            remarkIds: [],
            conflicting: false,
            wakes: 0,
          },
        },
      ],
    });

    const plan = planThreadRelocation({
      thread: child,
      parentThreadId: parent.id,
      parent,
      parentAncestorIds: new Set([parent.id]),
      familyThreads: [child],
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.updatedThreads).toHaveLength(1);
    const updated = plan.updatedThreads[0]!;
    expect(updated.lineage).toEqual({
      parentThreadId: parent.id,
      relationshipToParent: "subagent",
      rootThreadId: parent.id,
    });
    expect(updated.pinnedAt).toBeNull();
    expect(updated.pinOrderKey).toBeNull();
    expect(updated.activeOrderKey).toBeNull();
    expect(updated.snoozedAt).toBeNull();
    expect(updated.snoozedUntil).toBeNull();
    expect(updated.pullRequests?.[0]?.watch).toBeUndefined();
    expect(updated.pullRequests?.[0]?.endedWatch).toBeDefined();
    expect(updated.updatedAt).toBe(child.updatedAt);
  });

  it("cascades rootThreadId to descendants when relocating and when moving back to top level", () => {
    const parent = makeThread("parent");
    const child = makeThread("child");
    const grandchild = makeThread("grandchild", {
      lineage: {
        parentThreadId: child.id,
        relationshipToParent: "subagent",
        rootThreadId: child.id,
      },
    });

    const relocatePlan = planThreadRelocation({
      thread: child,
      parentThreadId: parent.id,
      parent,
      parentAncestorIds: new Set([parent.id]),
      familyThreads: [child, grandchild],
    });
    expect(relocatePlan.ok).toBe(true);
    if (!relocatePlan.ok) return;
    expect(relocatePlan.updatedThreads.map((t) => [t.id, t.lineage])).toEqual([
      [
        child.id,
        { parentThreadId: parent.id, relationshipToParent: "subagent", rootThreadId: parent.id },
      ],
      [
        grandchild.id,
        { parentThreadId: child.id, relationshipToParent: "subagent", rootThreadId: parent.id },
      ],
    ]);

    const [relocatedChild, relocatedGrandchild] = relocatePlan.updatedThreads;
    const detachPlan = planThreadRelocation({
      thread: relocatedChild!,
      parentThreadId: null,
      parent: null,
      parentAncestorIds: new Set(),
      familyThreads: [parent, relocatedChild!, relocatedGrandchild!],
    });
    expect(detachPlan.ok).toBe(true);
    if (!detachPlan.ok) return;
    expect(detachPlan.updatedThreads.map((t) => [t.id, t.lineage])).toEqual([
      [child.id, { parentThreadId: null, relationshipToParent: null, rootThreadId: child.id }],
      [
        grandchild.id,
        { parentThreadId: child.id, relationshipToParent: "subagent", rootThreadId: child.id },
      ],
    ]);
  });

  it("returns no updates when relocating to the same lineage (idempotent)", () => {
    const parent = makeThread("parent");
    const child = makeThread("child", {
      lineage: {
        parentThreadId: parent.id,
        relationshipToParent: "subagent",
        rootThreadId: parent.id,
      },
    });
    const plan = planThreadRelocation({
      thread: child,
      parentThreadId: parent.id,
      parent,
      parentAncestorIds: new Set([parent.id]),
      familyThreads: [parent, child],
    });
    expect(plan).toEqual({ ok: true, updatedThreads: [] });
  });

  it("rejects self-parenting, cycles, archived, provider-native, side chats, and delegated subagents", () => {
    const parent = makeThread("parent");
    const child = makeThread("child", {
      lineage: {
        parentThreadId: parent.id,
        relationshipToParent: "subagent",
        rootThreadId: parent.id,
      },
    });

    expect(
      planThreadRelocation({
        thread: parent,
        parentThreadId: parent.id,
        parent,
        parentAncestorIds: new Set([parent.id]),
        familyThreads: [parent],
      }).ok,
    ).toBe(false);

    expect(
      planThreadRelocation({
        thread: parent,
        parentThreadId: child.id,
        parent: child,
        parentAncestorIds: new Set([child.id, parent.id]),
        familyThreads: [parent, child],
      }).ok,
    ).toBe(false);

    expect(
      planThreadRelocation({
        thread: makeThread("archived", { archivedAt: NOW }),
        parentThreadId: parent.id,
        parent,
        parentAncestorIds: new Set([parent.id]),
        familyThreads: [],
      }).ok,
    ).toBe(false);

    expect(
      planThreadRelocation({
        thread: makeThread("native", {
          creationSource: "provider",
          lineage: {
            parentThreadId: parent.id,
            relationshipToParent: "subagent",
            rootThreadId: parent.id,
          },
        }),
        parentThreadId: null,
        parent: null,
        parentAncestorIds: new Set(),
        familyThreads: [],
      }).ok,
    ).toBe(false);

    expect(
      planThreadRelocation({
        thread: makeThread("side", {
          lineage: {
            parentThreadId: parent.id,
            relationshipToParent: "fork",
            rootThreadId: parent.id,
            sideChat: true,
          },
        }),
        parentThreadId: null,
        parent: null,
        parentAncestorIds: new Set(),
        familyThreads: [],
      }).ok,
    ).toBe(false);

    expect(
      planThreadRelocation({
        thread: makeThread("delegated", {
          forkedFrom: {
            type: "node",
            nodeId: "node-1" as never,
          },
        }),
        parentThreadId: null,
        parent: null,
        parentAncestorIds: new Set(),
        familyThreads: [],
      }).ok,
    ).toBe(false);
  });
});

describe("OrchestratorV2 thread.relocate", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const modelSelection = { instanceId, model: "gpt-5.1-codex" };
  const adapter = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("No provider process needed"),
  } as ProviderAdapter.ProviderAdapterV2["Service"];
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerTest = Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "thread-relocate" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ),
  ).pipe(Layer.provideMerge(NodeCrypto.layer));

  itEffect.effect(
    "relocates a parallel chat and its descendant under a parent, updates family queries, rejects cycles, and moves back to top level",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const projectId = ProjectId.make("project:relocate");
        const parentId = ThreadId.make("thread:parent");
        const parallelId = ThreadId.make("thread:parallel");
        const childOfParallelId = ThreadId.make("thread:child-of-parallel");

        const create = (threadId: ThreadId, title: string) =>
          orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create:${threadId}`),
            threadId,
            projectId,
            title,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });

        yield* create(parentId, "Parent");
        yield* create(parallelId, "Parallel");
        yield* create(childOfParallelId, "Child of parallel");

        // Pin parallel chat first to verify relocating clears sidebar pin state.
        yield* orchestrator.dispatch({
          type: "thread.pin",
          commandId: CommandId.make("pin:parallel"),
          threadId: parallelId,
        });

        // Nest childOfParallel under parallel first.
        yield* orchestrator.dispatch({
          type: "thread.relocate",
          commandId: CommandId.make("relocate:child-under-parallel"),
          threadId: childOfParallelId,
          parentThreadId: parallelId,
        });

        // Now relocate parallel under parent: both parallel and childOfParallel must join parent's family.
        yield* orchestrator.dispatch({
          type: "thread.relocate",
          commandId: CommandId.make("relocate:parallel-under-parent"),
          threadId: parallelId,
          parentThreadId: parentId,
        });

        const relocatedParallel = yield* projections.getThread(parallelId);
        const relocatedGrandchild = yield* projections.getThread(childOfParallelId);
        expect(relocatedParallel.lineage).toEqual({
          parentThreadId: parentId,
          relationshipToParent: "subagent",
          rootThreadId: parentId,
        });
        expect(relocatedParallel.pinnedAt).toBeNull();
        expect(relocatedGrandchild.lineage).toEqual({
          parentThreadId: parallelId,
          relationshipToParent: "subagent",
          rootThreadId: parentId,
        });

        const familyUnderParent = yield* projections.getShellSnapshot({
          location: "active",
          familyOf: parentId,
        });
        expect(familyUnderParent.threads.map((t) => t.id).toSorted()).toEqual(
          [parentId, parallelId, childOfParallelId].toSorted(),
        );

        const activeSubagents = yield* projections.listActiveSubagentThreadIds();
        expect(activeSubagents).toContain(parallelId);
        expect(activeSubagents).toContain(childOfParallelId);

        // Cycle check: relocating parent under its own grandchild must fail.
        const cycleExit = yield* Effect.exit(
          orchestrator.dispatch({
            type: "thread.relocate",
            commandId: CommandId.make("relocate:cycle"),
            threadId: parentId,
            parentThreadId: childOfParallelId,
          }),
        );
        expect(Exit.isFailure(cycleExit)).toBe(true);

        // Reverse: move parallel back to top level; grandchild follows parallel's new rootThreadId.
        yield* orchestrator.dispatch({
          type: "thread.relocate",
          commandId: CommandId.make("relocate:parallel-top-level"),
          threadId: parallelId,
          parentThreadId: null,
        });

        const detachedParallel = yield* projections.getThread(parallelId);
        const detachedGrandchild = yield* projections.getThread(childOfParallelId);
        expect(detachedParallel.lineage).toEqual({
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: parallelId,
        });
        expect(detachedGrandchild.lineage).toEqual({
          parentThreadId: parallelId,
          relationshipToParent: "subagent",
          rootThreadId: parallelId,
        });

        const parentFamilyAfter = yield* projections.getShellSnapshot({
          location: "active",
          familyOf: parentId,
        });
        expect(parentFamilyAfter.threads.map((t) => t.id)).toEqual([parentId]);

        const parallelFamilyAfter = yield* projections.getShellSnapshot({
          location: "active",
          familyOf: parallelId,
        });
        expect(parallelFamilyAfter.threads.map((t) => t.id).toSorted()).toEqual(
          [parallelId, childOfParallelId].toSorted(),
        );
      }).pipe(Effect.provide(layerTest)),
  );
});
