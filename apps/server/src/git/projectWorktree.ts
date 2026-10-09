import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

/**
 * Classifies a checkout an agent asks to bind: `"root"` for the project's own
 * workspace, `"worktree"` for another of the project's git worktrees, `null`
 * for anything else. Binding only listed worktrees keeps an agent from being
 * pointed at an arbitrary directory on the machine. Paths compare after
 * resolving symlinks.
 */
export const classifyProjectCheckout = Effect.fn("git.classifyProjectCheckout")(function* (
  workspaceRoot: string,
  worktreePath: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const real = (path: string) => fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));
  const worktrees = yield* git.listWorktreePaths(workspaceRoot).pipe(
    Effect.flatMap((paths) => Effect.forEach(paths, real)),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  const target = yield* real(worktreePath);
  if (!worktrees.includes(target)) return null;
  return target === (yield* real(workspaceRoot)) ? ("root" as const) : ("worktree" as const);
});
