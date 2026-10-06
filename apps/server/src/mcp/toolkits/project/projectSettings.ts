import {
  type Project,
  type ProjectId,
  type ProjectSettingsOverrides,
  type ProjectUpdatePayload,
} from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import type * as Types from "effect/Types";
import * as ServerSettings from "../../../serverSettings.ts";
import { unavailable } from "../../threadAccess.ts";

/**
 * Once the legacy project fields are folded into settings, the app reads a
 * project's scripts and defaults only from its settings override, so agent
 * writes land there too. The project service still records them on the
 * aggregate for servers that have not folded yet.
 */
export const writeProjectSettings = Effect.fn("writeProjectSettings")(function* (
  projectId: ProjectId,
  input: Pick<
    ProjectUpdatePayload,
    "scripts" | "defaultModelSelection" | "defaultThreadEnvMode" | "autoPull"
  >,
) {
  if (
    input.scripts === undefined &&
    input.defaultModelSelection === undefined &&
    input.defaultThreadEnvMode === undefined &&
    input.autoPull === undefined
  ) {
    return;
  }
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const settings = yield* settingsService.getSettings.pipe(Effect.mapError(unavailable));
  const entry: Types.Mutable<ProjectSettingsOverrides> = {
    ...settings.projectSettingsOverrides[projectId],
  };
  if (input.scripts !== undefined) entry.defaultProjectScripts = input.scripts;
  // A null project default means "inherit", which is no override at all.
  if (input.defaultModelSelection === null) delete entry.defaultModelSelection;
  else if (input.defaultModelSelection !== undefined) {
    entry.defaultModelSelection = input.defaultModelSelection;
  }
  if (input.defaultThreadEnvMode === null) delete entry.defaultThreadEnvMode;
  else if (input.defaultThreadEnvMode !== undefined) {
    entry.defaultThreadEnvMode = input.defaultThreadEnvMode;
  }
  if (input.autoPull !== undefined) entry.defaultAutoPull = input.autoPull;
  yield* settingsService
    .updateSettings({
      projectSettingsOverrides: { [projectId]: Object.keys(entry).length === 0 ? null : entry },
    })
    .pipe(Effect.mapError(unavailable));
});

/**
 * Shows projects with the scripts and defaults the app uses rather than the
 * aggregate's copies, which go stale once the app edits them in settings.
 */
export const projectSettingsView = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const settings = yield* settingsService.getSettings.pipe(Effect.mapError(unavailable));
  return (project: Project): Project => {
    const resolved = resolveProjectSettings(settings, project.id, project);
    return {
      ...project,
      scripts: resolveProjectScripts(settings, project),
      defaultModelSelection: resolved.overrides.defaultModelSelection ?? null,
      defaultThreadEnvMode: resolved.overrides.defaultThreadEnvMode ?? null,
      autoPull: resolved.settings.defaultAutoPull,
    };
  };
});
