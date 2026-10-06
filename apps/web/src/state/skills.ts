/**
 * Skills page (fork). Skills are scanned on the primary environment's server,
 * like boards, so every hook here reads that environment.
 */
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  FORK_SKILLS_WS_METHODS,
  type SkillFile,
  type SkillSaveResult,
  type SkillsList,
  type SkillsSettings,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { usePrimaryEnvironmentId } from "./environments";
import { useAtomCommand } from "./use-atom-command";

const scheduler = createAtomCommandScheduler();

const skillsEnvironment = {
  list: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:skills:list",
    tag: FORK_SKILLS_WS_METHODS.list,
    scheduler,
  }),
  read: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:skills:read",
    tag: FORK_SKILLS_WS_METHODS.read,
    scheduler,
  }),
  save: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:skills:save",
    tag: FORK_SKILLS_WS_METHODS.save,
    scheduler,
  }),
  saveSettings: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:skills:save-settings",
    tag: FORK_SKILLS_WS_METHODS.saveSettings,
    scheduler,
  }),
};

export type Loadable<A> =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly value: A };

type Outcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

export function failureMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return fallback;
}

/** Every skill with its projects and the page settings; `reload` scans again. */
export function useSkillsList(): {
  readonly list: Loadable<SkillsList>;
  readonly reload: () => void;
} {
  const environmentId = usePrimaryEnvironmentId();
  const run = useAtomCommand(skillsEnvironment.list, { reportFailure: false });
  const [revision, setRevision] = useState(0);
  const [list, setList] = useState<{
    readonly revision: number;
    readonly value: Loadable<SkillsList>;
  } | null>(null);
  useEffect(() => {
    if (environmentId === null) return;
    let cancelled = false;
    void run({ environmentId, input: {} }).then((result) => {
      if (cancelled) return;
      setList({
        revision,
        value:
          result._tag === "Success"
            ? { status: "ready", value: result.value }
            : {
                status: "error",
                message: failureMessage(
                  squashAtomCommandFailure(result),
                  "Skills could not be listed. The server may need a restart to support this page.",
                ),
              },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, revision, run]);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  return {
    list: list !== null && list.revision === revision ? list.value : { status: "loading" },
    reload,
  };
}

/** One SKILL.md's content; null path reads nothing. */
export function useSkillFile(path: string | null): {
  readonly file: Loadable<SkillFile> | null;
  readonly reload: () => void;
} {
  const environmentId = usePrimaryEnvironmentId();
  const run = useAtomCommand(skillsEnvironment.read, { reportFailure: false });
  const [revision, setRevision] = useState(0);
  const [file, setFile] = useState<{
    readonly key: string;
    readonly value: Loadable<SkillFile>;
  } | null>(null);
  const key = `${path}:${revision}`;
  useEffect(() => {
    if (environmentId === null || path === null) return;
    let cancelled = false;
    void run({ environmentId, input: { path } }).then((result) => {
      if (cancelled) return;
      setFile({
        key,
        value:
          result._tag === "Success"
            ? { status: "ready", value: result.value }
            : {
                status: "error",
                message: failureMessage(
                  squashAtomCommandFailure(result),
                  "The skill could not be read.",
                ),
              },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, key, path, run]);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  if (path === null) return { file: null, reload };
  return { file: file !== null && file.key === key ? file.value : { status: "loading" }, reload };
}

export function useSkillsCommands(): {
  readonly save: (file: SkillFile) => Promise<Outcome<SkillSaveResult>>;
  readonly saveSettings: (settings: SkillsSettings) => Promise<Outcome<SkillsSettings>>;
} {
  const environmentId = usePrimaryEnvironmentId();
  const save = useAtomCommand(skillsEnvironment.save, { reportFailure: false });
  const saveSettings = useAtomCommand(skillsEnvironment.saveSettings, { reportFailure: false });
  return {
    save: useCallback(
      async (file) => {
        if (environmentId === null) return { ok: false, message: "No server is connected." };
        const result = await save({ environmentId, input: file });
        return result._tag === "Success"
          ? { ok: true, value: result.value }
          : {
              ok: false,
              message: failureMessage(
                squashAtomCommandFailure(result),
                "The skill could not be saved.",
              ),
            };
      },
      [environmentId, save],
    ),
    saveSettings: useCallback(
      async (settings) => {
        if (environmentId === null) return { ok: false, message: "No server is connected." };
        const result = await saveSettings({ environmentId, input: settings });
        return result._tag === "Success"
          ? { ok: true, value: result.value }
          : {
              ok: false,
              message: failureMessage(
                squashAtomCommandFailure(result),
                "Settings could not be saved.",
              ),
            };
      },
      [environmentId, saveSettings],
    ),
  };
}
