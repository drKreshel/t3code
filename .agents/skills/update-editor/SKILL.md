---
name: update-editor
description: Develop, test, and ship changes to Kreshel's T3 Code fork (the editor they work in daily). Use when asked to change or fix T3 Code / "the editor" in this repo, start or restart the dev instance, refresh dev test data, pull official upstream changes into main, or rebuild, install, and restart the stable app (all in one go when asked to update).
---

# Update the editor

Kreshel runs this fork as their daily editor while changing it. Keep the working instance untouched.

## Instances

| Instance            | Where                                                                                | Data                             | Browser profile                        |
| ------------------- | ------------------------------------------------------------------------------------ | -------------------------------- | -------------------------------------- |
| Stable (daily work) | `/Applications/T3 Code (Alpha).app`, built from `main`                               | `~/.t3/userdata` (real chats)    | `~/Library/Application Support/t3code` |
| Dev (changes)       | `vp run dev:desktop` in `/Users/kreshel/Code/projects/t3-code-clone`                 | `~/.t3/dev` (copy of real chats) | `.../t3code-dev`                       |
| Build worktree      | `/Users/kreshel/Code/projects/t3-code-stable`, owned by `scripts/fork/stable-app.sh` | —                                | —                                      |

- This conversation may be running inside the stable app. Never quit, kill, or restart it, never start a server against `~/.t3/userdata`, and never edit the build worktree by hand.
- Folders are client-local (localStorage per profile), so dev and stable have separate folders by design.

## Develop

1. Work in the dev checkout on a feature branch off `main`.
2. `vp` is not installed globally: use `pnpm exec vp ...` from the checkout root.
3. Start the dev app in the background and track its PID: `pnpm exec vp run dev:desktop`. It defaults to `~/.t3/dev`; read the real ports from the `[dev-runner]` line. For browser testing use `pnpm exec vp run dev` with the `test-t3-app` skill.
4. Known dev glitch: the first window load can fail with `T3 Code failed to start ... main.tsx` (`ERR_INSUFFICIENT_RESOURCES`). Relaunch the window with `touch apps/desktop/dist-electron/preload.cjs`, or ask Kreshel to press ⌘R.
5. The desktop dev app runs a built server (`apps/server/dist`) with no watcher: after server or contracts changes run `pnpm exec vp pack` in `apps/server`; the app restarts on the new build. The web UI hot-reloads by itself.
6. Stopping a `dev:desktop` run means its whole tree, including `scripts/dev-electron.mjs`. A leftover `dev-electron.mjs` relaunches a second dev app on the same `~/.t3/dev`, which double-fires automations.
7. Stop only processes you started, by PID. If Kreshel started the dev app, ask before stopping it.
8. Verify with targeted `pnpm exec tsc --noEmit` (in `apps/web`), `pnpm exec vp test run <files>`, and `pnpm exec vp lint <files>`. No repo-wide checks.

Refresh dev data only with the dev app stopped: move the old `~/.t3/dev/state.sqlite*` into `~/.t3/backups/`, then snapshot with
`sqlite3 -readonly ~/.t3/userdata/state.sqlite "VACUUM INTO '$HOME/.t3/dev/state.sqlite'"`. Never copy `environment-id`.

## Branches

- `upstream` is the official `pingdotgg/t3code` (pull only); `origin` is the fork `drKreshel/t3code`.
- `main` is the fork's stable line: upstream plus merged fork features.
- Commit finished work and upstream merges on the right branch with conventional messages. Ask before pushing to `origin`; never push to `upstream`.
- Keep fork changes merge-friendly: logic in new files, thin hooks into upstream files.

## Update from upstream, all in one go

When asked to update, pull upstream, or ship: do every step below without stopping unless something is unsafe.

1. In the dev checkout, check `git status` and running dev processes. Carry uncommitted work along (stash it or commit it on its branch) rather than discarding it. Switch to `main`.
2. `git fetch upstream` and summarize `git log --oneline main..upstream/main`. If there is nothing new and `main` is already installed (`scripts/fork/stable-app.sh status`), say so and stop.
3. `git merge upstream/main`. Resolve conflicts keeping both upstream's change and the fork feature's intent; if a conflict cannot be resolved safely, stop and show it.
4. Verify only what the merge touched: `pnpm exec tsc --noEmit` in `apps/web` (and the server package if server files conflicted), plus `pnpm exec vp test run` for the fork's tests (`apps/web/src/components/SidebarFolders.logic.test.ts`) and tests of conflicted files.
5. Commit the merge (keep git's default merge message), and ask whether to push `main` to `origin`.
6. `scripts/fork/stable-app.sh build` (a few minutes; the app keeps running).
7. Write the final summary for Kreshel first, then run `scripts/fork/stable-app.sh restart` as the very last action. It detaches from the app, waits 15 seconds so the reply can finish, quits T3 Code, backs up chats and folders, installs the build, and reopens the app. The chat ends when the app quits; everything is back after reopen. Progress and errors go to `~/.t3/backups/restart.log`, and a macOS notification reports the result.

## Ship to stable

`scripts/fork/stable-app.sh`:

- `build [ref]` builds `main` (or `ref`) in the build worktree. Needs Rust (`cargo`, found automatically).
- `restart` quits, installs the last build, and reopens. Safe to run from a chat inside the app.
- `ship [ref]` runs `build`, then `restart`.
- `install` alone refuses while the app runs; Kreshel can use it from Terminal after ⌘Q.
- `rollback` swaps back to the previous app. `backup` and `status` do what they say.

Chats (`~/.t3/userdata`) and folders (the `t3code` profile) stay in place across installs, and every install backs them up to `~/.t3/backups/` first. A newer build may migrate the database on first launch; the backup is the way back.
