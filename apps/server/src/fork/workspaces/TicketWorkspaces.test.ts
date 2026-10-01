// @effect-diagnostics nodeBuiltinImport:off - the fake git runs real git in temp folders.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationProjectShell,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { BoardsService, layerMemory as boardsLayerMemory } from "../boards/BoardsService.ts";
import { layerMemory, TicketWorkspaces } from "./TicketWorkspaces.ts";

const ENVIRONMENT_ID = EnvironmentId.make("env-1");

const run = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

/** A repo with one commit on `main` and a `feature` branch. */
function makeRepo(dir: string) {
  NodeFS.mkdirSync(dir, { recursive: true });
  run(dir, "init", "-q", "-b", "main");
  run(dir, "config", "user.email", "test@example.com");
  run(dir, "config", "user.name", "Test");
  NodeFS.writeFileSync(NodePath.join(dir, "README.md"), "hello\n");
  run(dir, "add", ".");
  run(dir, "commit", "-q", "-m", "init");
  run(dir, "branch", "feature");
}

/** Just enough of the git service, backed by real git. */
const fakeGit = Layer.mock(GitWorkflowService.GitWorkflowService)({
  isRepository: (cwd) => Effect.sync(() => NodeFS.existsSync(NodePath.join(cwd, ".git"))),
  hasCommit: ({ cwd, refName }) =>
    Effect.sync(() => {
      try {
        run(cwd, "rev-parse", "--verify", "--quiet", `${refName}^{commit}`);
        return true;
      } catch {
        return false;
      }
    }),
  fetchRemote: () => Effect.void,
  pruneWorktrees: ({ cwd }) => Effect.sync(() => void run(cwd, "worktree", "prune")),
  createWorktree: (input) =>
    Effect.sync(() => {
      const path = input.path!;
      if (input.newRefName)
        run(input.cwd, "worktree", "add", "-q", "-b", input.newRefName, path, input.refName);
      else run(input.cwd, "worktree", "add", "-q", path, input.refName);
      return { worktree: { refName: input.newRefName ?? input.refName, path } };
    }) as never,
  removeWorktree: ({ cwd, path }) =>
    Effect.sync(() => void run(cwd, "worktree", "remove", "--force", path)),
  status: ({ cwd }) =>
    Effect.sync(
      () =>
        ({
          hasWorkingTreeChanges: run(cwd, "status", "--porcelain") !== "",
          hasUpstream: false,
          aheadCount: 0,
          aheadOfDefaultCount: Number(run(cwd, "rev-list", "--count", "main..HEAD")),
        }) as unknown as VcsStatusResult,
    ),
});

/**
 * Two projects in a temp folder: `single` is one repo; `multi` holds two
 * repos plus a shared instructions file.
 */
const makeHarness = Effect.gen(function* () {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ticket-ws-"));
  makeRepo(NodePath.join(root, "single"));
  const multi = NodePath.join(root, "multi");
  makeRepo(NodePath.join(multi, "app"));
  makeRepo(NodePath.join(multi, "api"));
  NodeFS.writeFileSync(NodePath.join(multi, "AGENTS.md"), "shared\n");
  const projects = new Map([
    ["single", NodePath.join(root, "single")],
    ["multi", multi],
  ]);
  const dependencies = Layer.mergeAll(
    fakeGit,
    Layer.mock(ProjectionSnapshotQuery)({
      getProjectShellById: (id) =>
        Effect.succeed(
          projects.has(id)
            ? Option.some({
                id,
                title: String(id),
                workspaceRoot: projects.get(id)!,
              } as unknown as OrchestrationProjectShell)
            : Option.none(),
        ),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
    }),
    ServerConfig.layerTest(root, NodePath.join(root, "t3")),
  );
  const workspaces = yield* TicketWorkspaces.pipe(
    Effect.provide(layerMemory.pipe(Layer.provide(dependencies))),
  );
  const boards = yield* BoardsService;
  const ticketOn = (project: string, key: string) =>
    Effect.gen(function* () {
      const boardId = (yield* boards.dispatch(
        { type: "board.create", name: key, key, defaultProjectKey: `${ENVIRONMENT_ID}:${project}` },
        "user",
      )).id!;
      const ticketId = (yield* boards.dispatch(
        { type: "ticket.create", boardId, title: "Work" },
        "user",
      )).id!;
      return { boardId, ticketId };
    });
  return { root, workspaces, boards, ticketOn };
});

const TestLayer = boardsLayerMemory.pipe(Layer.provideMerge(NodeServices.layer));

describe("TicketWorkspaces", () => {
  it.effect("gives a single-repo ticket a worktree on its branch and reuses it", () =>
    Effect.gen(function* () {
      const { workspaces, ticketOn } = yield* makeHarness;
      const { ticketId } = yield* ticketOn("single", "SGL");
      const first = yield* workspaces.dispatch({ type: "workspace.ensure", ticketId });
      expect(first.created).toBe(true);
      expect(first.branch).toBe("ticket/sgl-1");
      expect(run(first.path!, "branch", "--show-current")).toBe("ticket/sgl-1");
      const again = yield* workspaces.dispatch({ type: "workspace.ensure", ticketId });
      expect(again).toMatchObject({ path: first.path, created: false });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("mirrors a folder of repos: worktrees, local links, and shared files", () =>
    Effect.gen(function* () {
      const { root, workspaces, ticketOn } = yield* makeHarness;
      const { boardId, ticketId } = yield* ticketOn("multi", "MLT");
      // Nothing chosen yet: a folder of repos includes none by default.
      const refused = yield* workspaces
        .dispatch({ type: "workspace.ensure", ticketId })
        .pipe(Effect.flip);
      expect(refused.message).toMatch(/Pick the repos/);

      yield* workspaces.dispatch({
        type: "rules.set",
        scope: "board",
        scopeId: boardId,
        defaults: {},
        repos: [
          { repo: "app", checkout: "worktree", startFrom: "feature" },
          { repo: "api", checkout: "local" },
        ],
      });
      const workspace = yield* workspaces.dispatch({ type: "workspace.ensure", ticketId });
      const folder = workspace.path!;
      expect(workspace.branch).toBeNull();
      expect(run(NodePath.join(folder, "app"), "branch", "--show-current")).toBe("ticket/mlt-1");
      expect(run(NodePath.join(folder, "app"), "rev-parse", "HEAD")).toBe(
        run(NodePath.join(root, "multi", "app"), "rev-parse", "feature"),
      );
      expect(NodeFS.realpathSync(NodePath.join(folder, "api"))).toBe(
        NodeFS.realpathSync(NodePath.join(root, "multi", "api")),
      );
      expect(NodeFS.readFileSync(NodePath.join(folder, "AGENTS.md"), "utf8")).toBe("shared\n");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("refuses to remove unsaved work, and recreates from the branch after removal", () =>
    Effect.gen(function* () {
      const { root, workspaces, ticketOn } = yield* makeHarness;
      const { ticketId } = yield* ticketOn("single", "RMV");
      const { path } = yield* workspaces.dispatch({ type: "workspace.ensure", ticketId });
      NodeFS.writeFileSync(NodePath.join(path!, "change.txt"), "work\n");

      const refused = yield* workspaces
        .dispatch({ type: "workspace.remove", ticketId })
        .pipe(Effect.flip);
      expect(refused).toMatchObject({ code: "unsaved" });
      expect(refused.message).toMatch(/uncommitted changes/);

      run(path!, "add", ".");
      run(path!, "commit", "-q", "-m", "work");
      const stillRefused = yield* workspaces
        .dispatch({ type: "workspace.remove", ticketId })
        .pipe(Effect.flip);
      expect(stillRefused.message).toMatch(/never pushed/);

      yield* workspaces.dispatch({ type: "workspace.remove", ticketId, force: true });
      expect(NodeFS.existsSync(path!)).toBe(false);
      expect(yield* workspaces.find(ticketId)).toBeNull();

      // The branch kept the commit; the next chat gets it back.
      const recreated = yield* workspaces.dispatch({ type: "workspace.ensure", ticketId });
      expect(recreated.created).toBe(true);
      expect(NodeFS.readFileSync(NodePath.join(recreated.path!, "change.txt"), "utf8")).toBe(
        "work\n",
      );
      expect(run(NodePath.join(root, "single"), "branch", "--list", "ticket/rmv-1")).toContain(
        "ticket/rmv-1",
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps a workspace's branch and project, and says when none is needed", () =>
    Effect.gen(function* () {
      const { workspaces, boards, ticketOn } = yield* makeHarness;
      const { boardId, ticketId } = yield* ticketOn("single", "KEY");
      yield* workspaces.dispatch({ type: "workspace.ensure", ticketId });
      // Git keeps the branch it made; a new board key does not rename it.
      yield* boards.dispatch({ type: "board.update", boardId, key: "RENAM" }, "user");
      const reused = yield* workspaces.dispatch({ type: "workspace.ensure", ticketId });
      expect(reused).toMatchObject({ branch: "ticket/key-1", created: false });

      yield* boards.dispatch(
        { type: "ticket.update", ticketId, projectKey: `${ENVIRONMENT_ID}:multi` },
        "user",
      );
      const otherProject = yield* workspaces
        .dispatch({ type: "workspace.ensure", ticketId })
        .pipe(Effect.flip);
      expect(otherProject.message).toMatch(/made for another project/);

      const local = yield* ticketOn("single", "LCL");
      yield* workspaces.dispatch({
        type: "rules.set",
        scope: "board",
        scopeId: local.boardId,
        defaults: { checkout: "local" },
        repos: [],
      });
      const none = yield* workspaces
        .dispatch({ type: "workspace.ensure", ticketId: local.ticketId })
        .pipe(Effect.flip);
      expect(none.code).toBe("no-workspace");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("refuses to remove files made beside the repos of a folder", () =>
    Effect.gen(function* () {
      const { workspaces, ticketOn } = yield* makeHarness;
      const { boardId, ticketId } = yield* ticketOn("multi", "BSD");
      yield* workspaces.dispatch({
        type: "rules.set",
        scope: "board",
        scopeId: boardId,
        defaults: {},
        repos: [
          { repo: "app", checkout: "worktree" },
          { repo: "api", checkout: "local" },
        ],
      });
      const { path } = yield* workspaces.dispatch({ type: "workspace.ensure", ticketId });
      NodeFS.writeFileSync(NodePath.join(path!, "notes.md"), "plan\n");
      const refused = yield* workspaces
        .dispatch({ type: "workspace.remove", ticketId })
        .pipe(Effect.flip);
      expect(refused.code).toBe("unsaved");
      expect(refused.message).toMatch(/notes\.md: only in the workspace folder/);
      // Links (the shared AGENTS.md, the local api) and the clean worktree are fine.
      NodeFS.rmSync(NodePath.join(path!, "notes.md"));
      yield* workspaces.dispatch({ type: "workspace.remove", ticketId });
      expect(NodeFS.existsSync(path!)).toBe(false);
    }).pipe(Effect.provide(TestLayer)),
  );
});
