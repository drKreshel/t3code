import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
  type ProjectScript,
  type ModelSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  BoardsService,
  layerMemory as boardsLayerMemory,
} from "../../../fork/boards/BoardsService.ts";
import { TaskFolders } from "../../../fork/taskFolders/TaskFolders.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

it.effect(
  "a launch joins the ticket and folder it names, and a wrong ticket key creates nothing",
  () =>
    Effect.gen(function* () {
      const sourceThreadId = ThreadId.make("source-thread");
      const projectId = ProjectId.make("project");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
      const caller = {
        id: sourceThreadId,
        projectId,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        activeRunId: "active-run",
        archivedAt: null,
        deletedAt: null,
      } as OrchestrationV2ThreadShell;
      const launched: Array<ThreadId | undefined> = [];
      const filed: Array<{ readonly threadId: ThreadId; readonly folder: string | null }> = [];
      const layerDependencies = Layer.mergeAll(
        ServerSettings.layerTest(),
        NodeCrypto.layer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment"),
          requestNamespace: "session",
          thread: { threadId: sourceThreadId, providerSessionId: "session", providerInstanceId },
          client: undefined,
          issuedAt: 0,
          capabilities: new Set(["orchestration" as const]),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(caller),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) => {
            launched.push(input.threadId);
            return Effect.succeed({
              threadId: input.threadId,
              projection: {
                thread: { id: input.threadId, title: input.title, projectId, modelSelection },
                runs: [],
              },
              resumed: false,
            } as unknown as ThreadLaunch.ThreadLaunchResult);
          },
        }),
        Layer.mock(TaskFolders)({
          setChat: (input) => Effect.sync(() => void filed.push(input)),
        }),
        boardsLayerMemory.pipe(Layer.provide(NodeServices.layer)),
        Layer.mock(Project.ProjectService)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        NodeServices.layer,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-launch-placement-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      );
      const context = yield* Layer.build(layerDependencies);
      const boards = Context.get(context, BoardsService);
      const boardId = (yield* boards.dispatch(
        { type: "board.create", name: "Salon", key: "SALON" },
        "user",
      )).id!;
      yield* boards.dispatch({ type: "ticket.create", boardId, title: "Sign-in dead end" }, "user");
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(Layer.succeedContext(context)),
          ),
        ),
      );
      const launch = (params: Record<string, unknown>) =>
        toolkit
          .handle("t3_thread_launch", { title: "Review", message: "Review it", ...params } as never)
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provideContext(context));

      const placed = yield* launch({ ticket: "SALON-1", folder: "Salon/tickets/1/review-rounds" });
      const threadId = launched[0]!;
      expect(placed.at(-1)?.result).toMatchObject({ threadId });
      const ticket = (yield* boards.snapshot).tickets[0]!;
      expect(ticket.threadKeys).toEqual([`environment:${threadId}`]);
      expect(filed).toEqual([{ threadId, folder: "Salon/tickets/1/review-rounds" }]);

      const refused = yield* launch({ ticket: "SALON-9" });
      expect(refused.at(-1)?.result).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("There is no ticket SALON-9."),
      });
      expect(launched).toHaveLength(1);
    }).pipe(Effect.scoped),
);

it.effect("project scripts and defaults go where the app reads them", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const projectId = ProjectId.make("project:repo");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const script = (id: string): ProjectScript => ({
      id,
      name: id,
      command: `npm run ${id}`,
      icon: "play",
      runOnWorktreeCreate: false,
    });
    const caller = {
      id: sourceThreadId,
      projectId,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    // The aggregate's copy went stale when the app edited scripts in settings.
    let project: ProjectRecord = {
      id: projectId,
      title: "Repo",
      workspaceRoot: "/work/repo",
      defaultModelSelection: null,
      scripts: [script("stale")],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      deletedAt: null,
    };
    const layers = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        client: undefined,
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(Project.ProjectService)({
        getById: () => Effect.sync(() => Option.some(project)),
        update: (input) =>
          Effect.sync(() => {
            project = {
              ...project,
              scripts: input.scripts ?? project.scripts,
              defaultModelSelection:
                input.defaultModelSelection === undefined
                  ? project.defaultModelSelection
                  : input.defaultModelSelection,
            };
            return project;
          }),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      NodeServices.layer,
      ServerSettings.layerTest({
        projectSettingsFolded: true,
        projectSettingsOverrides: {
          [projectId]: { defaultProjectScripts: [script("dev")], defaultAutoPull: true },
        },
      }),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-settings-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    // Built once so settings written by one call are what the next one reads.
    const dependencies = Layer.succeedContext(yield* Layer.build(layers));
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const run = <Name extends "t3_project_read" | "t3_project_update">(
      name: Name,
      params: Parameters<typeof toolkit.handle<Name>>[1],
    ) =>
      toolkit
        .handle(name, params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    const overrides = ServerSettings.ServerSettingsService.pipe(
      Effect.flatMap((settings) => settings.getSettings),
      Effect.map((settings) => settings.projectSettingsOverrides[projectId]),
      Effect.provide(dependencies),
    );

    // An agent reads the scripts the app shows, not the stale aggregate copy.
    const read = yield* run("t3_project_read", { projectId });
    expect(read.at(-1)?.result).toMatchObject({ scripts: [script("dev")], autoPull: true });

    const model = { instanceId: providerInstanceId, model: "gpt-5" };
    const updated = yield* run("t3_project_update", {
      projectId,
      scripts: [script("dev"), script("all")],
      defaultModelSelection: model,
    });
    expect(updated.at(-1)?.result).toMatchObject({
      scripts: [script("dev"), script("all")],
      defaultModelSelection: model,
    });
    expect(yield* overrides).toEqual({
      defaultProjectScripts: [script("dev"), script("all")],
      defaultAutoPull: true,
      defaultModelSelection: model,
    });

    // A null default clears the override so the project inherits again.
    yield* run("t3_project_update", { projectId, defaultModelSelection: null });
    expect(yield* overrides).toEqual({
      defaultProjectScripts: [script("dev"), script("all")],
      defaultAutoPull: true,
    });
  }),
);
const clientLaunchHarness = (input: {
  readonly runtimeModeCeiling: RuntimeMode;
  readonly defaultRuntimeMode?: RuntimeMode;
  /** Where Settings saves a project's model; the legacy project field stays null. */
  readonly overrideModel?: ModelSelection;
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly workspaceRoot?: string;
  readonly checkWorktreeBase?: ThreadLaunch.ThreadLaunchService["Service"]["checkWorktreeBase"];
}) => {
  const projectId = ProjectId.make("project:client-target");
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus",
  };
  const layerDependencies = Layer.mergeAll(
    ServerSettings.layerTest({
      ...(input.defaultRuntimeMode === undefined
        ? {}
        : { defaultRuntimeMode: input.defaultRuntimeMode }),
      ...(input.overrideModel === undefined
        ? {}
        : {
            projectSettingsFolded: true,
            projectSettingsOverrides: {
              [projectId]: { defaultModelSelection: input.overrideModel },
            },
          }),
    }),
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session-1",
      thread: undefined,
      client: {
        sessionId: "session-1",
        label: "Claude Code",
        access: input.runtimeModeCeiling,
      },
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({}),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      checkWorktreeBase: input.checkWorktreeBase ?? (() => Effect.void),
      launch: (launch) => {
        input.launched.push(launch);
        return Effect.succeed({
          threadId: launch.threadId,
          projection: {
            thread: {
              id: launch.threadId,
              projectId: launch.projectId,
              title: launch.title,
              modelSelection: launch.modelSelection,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id,
                workspaceRoot: input.workspaceRoot ?? "/projects/client-target",
                defaultModelSelection: input.overrideModel === undefined ? modelSelection : null,
              } as unknown as ProjectRecord)
            : Option.none(),
        ),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    NodeServices.layer,
  ).pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-client-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { projectId, modelSelection, dependencies: layerDependencies };
};

it.effect(
  "a client launches with the project's default model and mode, capped at its ceiling",
  () =>
    Effect.gen(function* () {
      const launchWith = Effect.fn("test.launchWith")(function* (
        runtimeModeCeiling: RuntimeMode,
        defaultRuntimeMode: RuntimeMode,
        params: {
          readonly title: string;
          readonly message?: string;
          readonly runtimeMode?: RuntimeMode;
          readonly targeted?: false;
          readonly overrideModel?: ModelSelection;
        },
      ) {
        const { targeted, overrideModel, ...input } = params;
        const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
        const { projectId, modelSelection, dependencies } = clientLaunchHarness({
          runtimeModeCeiling,
          defaultRuntimeMode,
          launched,
          ...(overrideModel === undefined ? {} : { overrideModel }),
        });
        const toolkit = yield* ProjectToolkit.pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
              Layer.provide(dependencies),
            ),
          ),
        );
        const result = yield* toolkit
          .handle("t3_thread_launch", targeted === false ? input : { ...input, projectId })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
        return { result: result.at(-1)?.result, launched, projectId, modelSelection };
      });

      const belowCeiling = yield* launchWith("full-access", "approval-required", {
        title: "Fix",
        message: "Fix the bug",
      });
      expect(belowCeiling.result).toMatchObject({
        projectId: belowCeiling.projectId,
        modelSelection: belowCeiling.modelSelection,
        link: `[Fix](t3-thread://v1/${belowCeiling.launched[0]?.threadId})`,
      });
      expect(belowCeiling.launched[0]?.runtimeMode).toBe("approval-required");
      expect(belowCeiling.launched[0]?.initialMessage?.senderThreadId).toBeUndefined();

      const aboveCeiling = yield* launchWith("auto-accept-edits", "full-access", { title: "Fix" });
      expect(aboveCeiling.launched[0]?.runtimeMode).toBe("auto-accept-edits");

      const requested = yield* launchWith("full-access", "approval-required", {
        title: "Fix",
        runtimeMode: "auto",
      });
      expect(requested.launched[0]?.runtimeMode).toBe("auto");

      const escalated = yield* launchWith("auto-accept-edits", "auto-accept-edits", {
        title: "Fix",
        runtimeMode: "full-access",
      });
      expect(escalated.result).toMatchObject({ code: "runtime_mode_escalation_denied" });
      expect(escalated.launched).toHaveLength(0);

      const untargeted = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        targeted: false,
      });
      expect(untargeted.result).toMatchObject({ code: "target_required" });

      const overrideModel = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-settings",
      };
      const fromSettings = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        overrideModel,
      });
      expect(fromSettings.launched[0]?.modelSelection).toEqual(overrideModel);
    }),
);

it.effect("a launch binds only an existing checkout that is one of the project's worktrees", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-launch-worktree-" });
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "feature");
    const outside = path.join(root, "outside");
    yield* fileSystem.makeDirectory(repo);
    yield* fileSystem.makeDirectory(outside);

    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      workspaceRoot: repo,
    });
    const git = yield* GitVcsDriver.GitVcsDriver.pipe(Effect.provide(dependencies));
    for (const args of [
      ["init", "-b", "main"],
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
      ["worktree", "add", "-b", "feature", worktree],
    ]) {
      yield* git.execute({ operation: "test.setupRepo", cwd: repo, args });
    }
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchInto = (worktreePath: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "existing_worktree", worktreePath },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({ projectId });
    expect((yield* launchInto(repo)).at(-1)?.result).toMatchObject({ projectId });
    for (const elsewhere of [outside, path.join(worktree, "..", "outside"), "/"]) {
      expect((yield* launchInto(elsewhere)).at(-1)?.result).toMatchObject({
        code: "invalid_request",
      });
    }
    expect(launched.map((launch) => launch.workspaceStrategy)).toEqual([
      { type: "existing_worktree", worktreePath: worktree },
      { type: "existing_worktree", worktreePath: repo },
    ]);

    yield* fileSystem.remove(worktree, { recursive: true });
    yield* fileSystem.makeDirectory(worktree);
    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a launch into a new worktree creates nothing when its base ref has no commit", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      checkWorktreeBase: ({ projectId, workspaceStrategy }) =>
        workspaceStrategy.type === "worktree" && workspaceStrategy.baseRef === "t3/renamed"
          ? Effect.fail(
              new ThreadLaunch.ThreadLaunchBaseRefError({
                projectId,
                projectTitle: "Client target",
                workspaceRoot: "/projects/client-target",
                baseRef: workspaceStrategy.baseRef,
              }),
            )
          : Effect.void,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchFrom = (baseRef: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "worktree", baseRef, startFromOrigin: false },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    const refused = (yield* launchFrom("t3/renamed")).at(-1)?.result;
    expect(refused).toMatchObject({ code: "invalid_request" });
    expect((refused as { message: string }).message).toContain(
      'Base ref "t3/renamed" does not resolve to a commit in project "Client target" (/projects/client-target). No thread was created.',
    );
    expect(launched).toHaveLength(0);

    expect((yield* launchFrom("main")).at(-1)?.result).toMatchObject({ projectId });
    expect(launched).toHaveLength(1);
  }),
);
