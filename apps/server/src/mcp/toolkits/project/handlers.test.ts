import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
  type ProjectScript,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectHandlersLive } from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

it.effect("attributes a launched thread's first message to the calling thread", () =>
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
    let launchedSender: ThreadId | undefined;
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        threadId: sourceThreadId,
        providerSessionId: "session",
        providerInstanceId,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) => {
          launchedSender = input.initialMessage?.senderThreadId;
          return Effect.succeed({
            threadId: input.threadId,
            projection: {
              thread: { id: input.threadId, projectId, modelSelection },
              runs: [],
            },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult);
        },
      }),
      Layer.mock(Project.ProjectService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      NodeServices.layer,
      ServerSettings.layerTest(),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-link-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(ProjectHandlersLive.pipe(Layer.provide(dependencies))),
    );
    const result = yield* toolkit
      .handle("t3_thread_launch", { title: "Audit", message: "Review the change" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(result.at(-1)?.result).toMatchObject({ projectId, modelSelection });
    expect(launchedSender).toBe(sourceThreadId);
  }),
);

it.effect("launches a scratch thread into the Scratch project", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const scratchProjectId = ProjectId.make("project:scratch");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
    const caller = {
      id: sourceThreadId,
      projectId: ProjectId.make("project:caller"),
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        threadId: sourceThreadId,
        providerSessionId: "session",
        providerInstanceId,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) => {
          launched.push(input);
          return Effect.succeed({
            threadId: input.threadId,
            projection: {
              thread: { id: input.threadId, projectId: input.projectId, modelSelection },
              runs: [],
            },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult);
        },
      }),
      Layer.mock(Project.ProjectService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        ensureScratchProject: Effect.succeed({ projectId: scratchProjectId }),
      }),
      NodeServices.layer,
      ServerSettings.layerTest(),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-scratch-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(ProjectHandlersLive.pipe(Layer.provide(dependencies))),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"t3_thread_launch">>[1]) =>
      toolkit
        .handle("t3_thread_launch", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    const result = yield* handle({ title: "Notes", scratch: true, message: "Draft a list" });
    expect(result.at(-1)?.result).toMatchObject({ projectId: scratchProjectId });
    expect(launched.map((input) => [input.projectId, input.workspaceStrategy])).toEqual([
      [scratchProjectId, { type: "root" }],
    ]);

    const rejected = yield* handle({
      title: "Notes",
      scratch: true,
      projectId: caller.projectId,
    });
    expect(rejected.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    expect(launched).toHaveLength(1);
  }),
);

it.effect("starts a project from just a title when workspaceRoot is omitted", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const createdProjectId = ProjectId.make("project:named");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const caller = {
      id: sourceThreadId,
      projectId: ProjectId.make("project:caller"),
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const named: Array<string> = [];
    const registered: Array<string> = [];
    const createdProject = {
      id: createdProjectId,
      title: "Pinball Stats",
      workspaceRoot: "/projects/pinball-stats",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      deletedAt: null,
    };
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        threadId: sourceThreadId,
        providerSessionId: "session",
        providerInstanceId,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(Project.ProjectService)({
        create: (input) =>
          Effect.sync(() => {
            registered.push(input.workspaceRoot);
            return { ...createdProject, id: input.projectId, workspaceRoot: input.workspaceRoot };
          }),
        getById: (projectId) =>
          Effect.succeed(
            projectId === createdProjectId ? Option.some(createdProject) : Option.none(),
          ),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        createNamedProject: (input) =>
          Effect.sync(() => {
            named.push(input.name);
            return {
              projectId: createdProjectId,
              workspaceRoot: createdProject.workspaceRoot,
              commitError: "Git has no name or email on this machine.",
            };
          }),
      }),
      NodeServices.layer,
      ServerSettings.layerTest(),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-named-project-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(ProjectHandlersLive.pipe(Layer.provide(dependencies))),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"t3_project_create">>[1]) =>
      toolkit
        .handle("t3_project_create", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    const result = yield* handle({ title: "Pinball Stats" });
    expect(result.at(-1)?.result).toMatchObject({
      id: createdProjectId,
      workspaceRoot: "/projects/pinball-stats",
      commitError: "Git has no name or email on this machine.",
    });
    expect(named).toEqual(["Pinball Stats"]);

    // A path still registers that folder, and never makes a named project.
    yield* handle({ title: "Existing", workspaceRoot: "/work/existing" });
    expect(registered).toEqual(["/work/existing"]);

    // Fields this mode cannot apply are rejected, not dropped.
    for (const extra of [
      { scripts: [] },
      { defaultModelSelection: { instanceId: providerInstanceId, model: "gpt-5" } },
    ]) {
      const rejected = yield* handle({ title: "Configured", ...extra });
      expect(rejected.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    }
    expect(named).toEqual(["Pinball Stats"]);
  }),
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
        threadId: sourceThreadId,
        providerSessionId: "session",
        providerInstanceId,
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
      Effect.provide(ProjectHandlersLive.pipe(Layer.provide(dependencies))),
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
