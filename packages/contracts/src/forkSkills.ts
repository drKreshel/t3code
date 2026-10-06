/**
 * Skills page (fork feature): every skill the configured agents load, merged
 * by name across providers, with the projects that can use it. Global skills
 * may come from a source folder (such as a Ruler folder) that a resync
 * command copies into each agent's skills folder; edits go to the source.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ProjectId } from "./baseSchemas.ts";

export const FORK_SKILLS_WS_METHODS = {
  list: "fork.skills.list",
  read: "fork.skills.read",
  save: "fork.skills.save",
  saveSettings: "fork.skills.saveSettings",
} as const;

export const SkillsSettings = Schema.Struct({
  /** Folder holding the source of personal skills, one `<name>/SKILL.md` each. */
  sourceDirectory: Schema.NullOr(Schema.String),
  /** Shell command that copies the source folder into each agent's skills folder. */
  resyncCommand: Schema.NullOr(Schema.String),
});
export type SkillsSettings = typeof SkillsSettings.Type;

/**
 * `global`: user scope, available in every project. `project`: inside one
 * project's folder. `builtin`: shipped by the agent or a plugin.
 */
export const SkillScope = Schema.Literals(["global", "project", "builtin"]);
export type SkillScope = typeof SkillScope.Type;

export const SkillLoad = Schema.Struct({
  providerName: Schema.String,
  /** The SKILL.md this agent reads. */
  path: Schema.String,
  enabled: Schema.Boolean,
});
export type SkillLoad = typeof SkillLoad.Type;

export const SkillEntry = Schema.Struct({
  /** Stable row id: scope, project, and name. */
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  scope: SkillScope,
  /** The project a `project` skill lives in. */
  projectId: Schema.NullOr(ProjectId),
  /** Agents that load it. Empty for a source skill no agent has picked up yet. */
  loads: Schema.Array(SkillLoad),
  /** Its SKILL.md in the source folder, for a global skill that has one. */
  sourcePath: Schema.NullOr(Schema.String),
  /** The file an edit writes: the source when there is one; null when not editable. */
  editPath: Schema.NullOr(Schema.String),
});
export type SkillEntry = typeof SkillEntry.Type;

export const SkillsProject = Schema.Struct({
  id: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
});
export type SkillsProject = typeof SkillsProject.Type;

export const SkillsList = Schema.Struct({
  skills: Schema.Array(SkillEntry),
  projects: Schema.Array(SkillsProject),
  settings: SkillsSettings,
});
export type SkillsList = typeof SkillsList.Type;

export const SkillFile = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
});
export type SkillFile = typeof SkillFile.Type;

export const SkillResync = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Int),
  output: Schema.String,
});
export type SkillResync = typeof SkillResync.Type;

export const SkillSaveResult = Schema.Struct({
  path: Schema.String,
  /** Null when the saved file is not in the source folder or no command is set. */
  resync: Schema.NullOr(SkillResync),
});
export type SkillSaveResult = typeof SkillSaveResult.Type;

export class SkillsError extends Schema.TaggedError<SkillsError>()("SkillsError", {
  code: Schema.Literals(["invalid", "not-found", "storage"]),
  message: Schema.String,
}) {}

const error = Schema.Union([SkillsError, EnvironmentAuthorizationError]);

export const ForkSkillsListRpc = Rpc.make(FORK_SKILLS_WS_METHODS.list, {
  payload: Schema.Struct({}),
  success: SkillsList,
  error,
});

export const ForkSkillsReadRpc = Rpc.make(FORK_SKILLS_WS_METHODS.read, {
  payload: Schema.Struct({ path: Schema.String }),
  success: SkillFile,
  error,
});

export const ForkSkillsSaveRpc = Rpc.make(FORK_SKILLS_WS_METHODS.save, {
  payload: SkillFile,
  success: SkillSaveResult,
  error,
});

export const ForkSkillsSaveSettingsRpc = Rpc.make(FORK_SKILLS_WS_METHODS.saveSettings, {
  payload: SkillsSettings,
  success: SkillsSettings,
  error,
});
