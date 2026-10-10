/**
 * Fork: the Skills page. Lists every skill the enabled agents load in each
 * project, reads and saves SKILL.md files, and keeps the source folder and
 * resync command for personal skills in `fork_settings`.
 */
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderInstanceId,
  type SkillFile,
  SkillsError,
  type SkillSaveResult,
  type SkillsList,
  SkillsSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProcessRunner from "../../processRunner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ForkDatabase from "../ForkDatabase.ts";
import { frontmatterDescription, mergeSkills, type SkillScan } from "./skillsLogic.ts";

export class SkillsService extends Context.Service<
  SkillsService,
  {
    readonly list: Effect.Effect<SkillsList, SkillsError>;
    readonly read: (path: string) => Effect.Effect<SkillFile, SkillsError>;
    readonly save: (file: SkillFile) => Effect.Effect<SkillSaveResult, SkillsError>;
    readonly saveSettings: (settings: SkillsSettings) => Effect.Effect<SkillsSettings, SkillsError>;
  }
>()("t3/fork/skills/SkillsService") {}

const SETTINGS_KEY = "skills";
const EMPTY_SETTINGS: SkillsSettings = { sourceDirectory: null, resyncCommand: null };
const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(SkillsSettings));
const encodeSettings = Schema.encodeSync(Schema.fromJsonString(SkillsSettings));

const storage = (message: string) => () => new SkillsError({ code: "storage", message });
const invalid = (message: string) => new SkillsError({ code: "invalid", message });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const hostEnvironment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;

  const readSettings = sql<{ readonly value_json: string }>`
    SELECT value_json FROM fork_settings WHERE key = ${SETTINGS_KEY}
  `.pipe(
    Effect.map((rows) =>
      rows[0] === undefined
        ? EMPTY_SETTINGS
        : Option.getOrElse(decodeSettings(rows[0].value_json), () => EMPTY_SETTINGS),
    ),
    Effect.mapError(storage("Skills settings could not be read.")),
  );

  const sourceDirectoryOf = (settings: SkillsSettings) =>
    settings.sourceDirectory
      ? path.resolve(expandHomePath(settings.sourceDirectory, homeDirectory))
      : null;

  const exists = (filePath: string) =>
    fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false));

  /** `<name>` to `<source>/<name>/SKILL.md` for each skill folder in the source folder. */
  const readSourceSkills = (directory: string | null) =>
    Effect.gen(function* () {
      const skills = new Map<string, string>();
      if (directory === null) return skills;
      const entries = yield* fileSystem
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const entry of entries.toSorted()) {
        const skillPath = path.join(directory, entry, "SKILL.md");
        if (yield* exists(skillPath)) skills.set(entry, skillPath);
      }
      return skills;
    });

  const list: SkillsService["Service"]["list"] = Effect.gen(function* () {
    const settings = yield* readSettings;
    const projectList = (yield* projects.snapshot.pipe(
      Effect.mapError(storage("Projects could not be read.")),
    )).projects.filter((project) => project.deletedAt === null);
    const machineProviders = yield* providers.getProviders;
    const enabled = (yield* instances.listInstances).filter((instance) => instance.enabled);
    const scans = yield* Effect.forEach(
      enabled,
      (instance) => {
        const providerName =
          PROVIDER_DISPLAY_NAMES[instance.driverKind] ??
          instance.displayName ??
          instance.instanceId;
        const machine: SkillScan = {
          providerName,
          projectId: null,
          projectRoot: null,
          skills:
            machineProviders.find((provider) => provider.instanceId === instance.instanceId)
              ?.skills ?? [],
        };
        const snapshotForCwd = instance.snapshotForCwd;
        if (snapshotForCwd === undefined) return Effect.succeed([machine]);
        return Effect.forEach(
          projectList,
          (project) =>
            snapshotForCwd(project.workspaceRoot).pipe(
              Effect.map((snapshot): SkillScan => ({
                providerName,
                projectId: project.id,
                projectRoot: project.workspaceRoot,
                skills: snapshot.status === "error" ? [] : snapshot.skills,
              })),
              Effect.orElseSucceed((): SkillScan => ({
                providerName,
                projectId: project.id,
                projectRoot: project.workspaceRoot,
                skills: [],
              })),
            ),
          { concurrency: 4 },
        ).pipe(Effect.map((projectScans) => [machine, ...projectScans]));
      },
      { concurrency: 4 },
    );
    const sourceSkills = yield* readSourceSkills(sourceDirectoryOf(settings));
    const merged = mergeSkills(scans.flat(), sourceSkills);
    // A source skill no agent loads has no reported description; read it.
    const skills = yield* Effect.forEach(
      merged,
      (skill) =>
        skill.description !== null || skill.sourcePath === null
          ? Effect.succeed(skill)
          : fileSystem.readFileString(skill.sourcePath).pipe(
              Effect.map((content) => ({ ...skill, description: frontmatterDescription(content) })),
              Effect.orElseSucceed(() => skill),
            ),
      { concurrency: 8 },
    );
    return {
      skills,
      projects: projectList.map((project) => ({
        id: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
      })),
      settings,
    };
  });

  /** Only SKILL.md files are readable and writable here. */
  const skillFile = (filePath: string) =>
    path.basename(filePath).toLowerCase() === "skill.md" && path.isAbsolute(filePath)
      ? Effect.succeed(path.resolve(filePath))
      : Effect.fail(invalid("Only SKILL.md files can be opened here."));

  const read: SkillsService["Service"]["read"] = (filePath) =>
    Effect.gen(function* () {
      const resolved = yield* skillFile(filePath);
      const content = yield* fileSystem
        .readFileString(resolved)
        .pipe(
          Effect.mapError(
            () => new SkillsError({ code: "not-found", message: `Could not read ${resolved}.` }),
          ),
        );
      return { path: resolved, content };
    });

  /** Re-scan skills everywhere they are cached, so composers pick up the edit. */
  const refreshProviderSkills = Effect.gen(function* () {
    for (const instance of yield* instances.listInstances) {
      yield* instance.invalidateCaches ?? Effect.void;
      yield* providers.refreshInstance(instance.instanceId);
    }
    for (const provider of yield* providers.getProviders) {
      for (const snapshot of provider.workspaceSnapshots ?? []) {
        yield* providers.refreshWorkspaceSnapshot({
          instanceId: provider.instanceId as ProviderInstanceId,
          cwd: snapshot.cwd,
          fresh: true,
        });
      }
    }
  }).pipe(Effect.ignoreCause({ log: true }));

  const runResync = (command: string) =>
    processRunner
      .run({
        command: hostEnvironment.SHELL || "/bin/sh",
        args: ["-lc", command],
        cwd: hostEnvironment.HOME,
        timeout: "2 minutes",
        outputMode: "truncate",
        maxOutputBytes: 64 * 1024,
      })
      .pipe(
        Effect.map((output) => ({
          exitCode: output.timedOut ? null : (output.code ?? null),
          output: `${output.stdout}${output.stderr}`.trim(),
        })),
        Effect.catch((error) => Effect.succeed({ exitCode: null, output: error.message })),
      );

  const save: SkillsService["Service"]["save"] = (file) =>
    Effect.gen(function* () {
      const resolved = yield* skillFile(file.path);
      if (!(yield* exists(resolved)))
        return yield* new SkillsError({
          code: "not-found",
          message: `${resolved} does not exist.`,
        });
      const settings = yield* readSettings;
      const sourceDirectory = sourceDirectoryOf(settings);
      const inSource =
        sourceDirectory !== null && path.dirname(path.dirname(resolved)) === sourceDirectory;
      const sourceCopy =
        sourceDirectory === null
          ? null
          : path.join(sourceDirectory, path.basename(path.dirname(resolved)), "SKILL.md");
      if (!inSource && sourceCopy !== null && (yield* exists(sourceCopy)))
        return yield* invalid(
          `This file is a synced copy and the next resync overwrites it. Edit the source at ${sourceCopy}.`,
        );
      yield* fileSystem
        .writeFileString(resolved, file.content)
        .pipe(Effect.mapError(storage(`Could not write ${resolved}.`)));
      const resync =
        inSource && settings.resyncCommand ? yield* runResync(settings.resyncCommand) : null;
      yield* refreshProviderSkills.pipe(Effect.forkDetach);
      return { path: resolved, resync };
    });

  const saveSettings: SkillsService["Service"]["saveSettings"] = (input) =>
    Effect.gen(function* () {
      const settings: SkillsSettings = {
        sourceDirectory: input.sourceDirectory?.trim() || null,
        resyncCommand: input.resyncCommand?.trim() || null,
      };
      const directory = sourceDirectoryOf(settings);
      if (directory !== null) {
        const stat = yield* fileSystem.stat(directory).pipe(Effect.option);
        if (Option.isNone(stat) || stat.value.type !== "Directory")
          return yield* invalid(`${directory} is not a folder.`);
      }
      yield* sql`
        INSERT INTO fork_settings (key, value_json) VALUES (${SETTINGS_KEY}, ${encodeSettings(settings)})
        ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json
      `.pipe(Effect.mapError(storage("Skills settings could not be saved.")));
      return settings;
    });

  return SkillsService.of({ list, read, save, saveSettings });
});

export const layer = Layer.effect(SkillsService, make).pipe(
  Layer.provide(ForkDatabase.layer),
  Layer.provide(ProcessRunner.layer),
);
