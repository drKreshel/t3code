---
name: update-editor
description: Develop, test, and ship changes to Kreshel's T3 Code fork (the editor they work in daily). Use when asked to change or fix T3 Code / "the editor" in this repo, start or restart the dev instance, refresh dev test data, pull official upstream changes into main, or rebuild, install, and restart the stable app (all in one go when asked to update).
---

# Update the editor

Kreshel runs this fork as their daily editor while changing it. Keep the working instance untouched.

## Instances

| Instance            | Where                                                                                | Data                             | Browser profile                           |
| ------------------- | ------------------------------------------------------------------------------------ | -------------------------------- | ----------------------------------------- |
| Stable (daily work) | `/Applications/T3 Code (Alpha).app`, built from `main`                               | `~/.t3/userdata` (real chats)    | `~/Library/Application Support/t3code-v2` |
| Dev (changes)       | `vp run dev:desktop` in `/Users/kreshel/Code/projects/t3-code-clone`                 | `~/.t3/dev` (copy of real chats) | `.../t3code-dev`                          |
| Build worktree      | `/Users/kreshel/Code/projects/t3-code-stable`, owned by `scripts/fork/stable-app.sh` | —                                | —                                         |

- This conversation may be running inside the stable app. Never quit, kill, or restart it, never start a server against `~/.t3/userdata`, and never edit the build worktree by hand.
- Folders are client-local (localStorage per profile), so dev and stable have separate folders by design.
- The pre-v2 stable profile is `~/Library/Application Support/t3code`. Switching profiles needs an explicit folder migration; the chat database migration does not carry localStorage with it.

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
- Commit finished work and upstream merges on the right branch with conventional messages. Ask before pushing feature work to `origin`; an upstream update pushes `main` on its own (below). Never push to `upstream`.
- Keep fork changes merge-friendly: logic in new files, thin hooks into upstream files.
- [`FORK.md`](../../../FORK.md) lists each fork feature, the upstream files it touches, and where its data lives. Update it in the same commit when a fork feature lands, moves, or is dropped.

## Update from upstream, all in one go

When asked to update, pull upstream, or ship: finish every step below unattended. Kreshel expects to come back to an updated, reopened app, so fix forward instead of giving up.

Preserve folder and board data using the [update-t3 preservation guidance](../update-t3/SKILL.md). Record their existing state before updating. Verify that backups cover the active Electron profile and the current server/fork persistence, including board data. Prepare any required migration before installing, then compare folders and boards after reopening. Keep their names, structure, ordering, chat assignments, tickets, links, and hooks unchanged unless the user requested a change. An empty sidebar or board after an update is a migration failure to recover, not a successful update. If restart ends this turn, report verification as pending until it is actually checked.

1. In the dev checkout, check `git status` and running dev processes. Carry uncommitted work along (stash it or commit it on its branch) rather than discarding it. Switch to `main`.
2. `git fetch upstream` and summarize `git log --oneline main..upstream/main`. If there is nothing new and `main` is already installed (`scripts/fork/stable-app.sh status`), say so and stop. Otherwise compare the new upstream work against `FORK.md` and note every feature or fix that overlaps a fork one.
3. `git merge upstream/main`. Resolve conflicts in the spirit of both sides: keep upstream's change and the fork feature's intent, and adapt fork code to upstream's renamed services, new APIs, and dependency upgrades. Handle overlaps as described under "Upstream wins by default" below.
4. Verify only what the merge touched: `pnpm exec tsc --noEmit` in `apps/web` (and the server package if server files changed), plus `pnpm exec vp test run` for the fork's tests (`apps/web/src/components/SidebarFolders.logic.test.ts`) and tests of conflicted files. A failure is work to do, not a stop: fix the fork code (for example imports broken by a library upgrade) and rerun until green.
5. Commit the merge (keep git's default merge message; put follow-up fixes in the merge or in `fix(fork): ...` commits) and push `main` to `origin`.
6. `scripts/fork/stable-app.sh build` (a few minutes; the app keeps running). If it fails, fix the cause, commit, push, and build again.
7. Write the final summary for Kreshel first, then run `scripts/fork/stable-app.sh restart` as the very last action. It detaches from the app, waits 15 seconds so the reply can finish, quits T3 Code, backs up chats and folders, installs the build, and reopens the app. The chat ends when the app quits; everything is back after reopen. Progress and errors go to `~/.t3/backups/restart.log`, and a macOS notification reports the result.

The summary lists the touching points: each place where upstream and a fork feature met, how it was merged, and any fork code adapted to upstream. Call out every overlap decision (below) on its own line: what upstream shipped, what was kept from the fork and why, and what Kreshel should try. Keep it to what Kreshel should know or check, not a commit log.

### Upstream wins by default

When upstream ships a feature or fix that overlaps a fork one, prefer upstream's: it will keep being maintained and merged cleanly. Do not stop for this; decide, finish the update, and report.

- Same or better upstream: switch to upstream's, migrate the fork's data into it so nothing Kreshel had is lost, and delete the fork code and its `FORK.md` row. Automations folding into upstream scheduled tasks is the model.
- Upstream's is better overall, but the fork does something it lacks that Kreshel uses: adopt upstream's as the base and re-add only that piece as a thin fork addition on top (new files, a small hook). Update the `FORK.md` row to describe just that addition.
- The fork's is clearly better and upstream's adds nothing Kreshel would use: keep the fork's, leave upstream's reachable as upstream ships it, and explain the choice in the summary so Kreshel can overrule it.
- An upstream fix for a bug the fork also patched (see "Fixes upstream could take" in `FORK.md`): take upstream's and drop the fork patch.

Stop and ask only when a choice cannot be made safely without Kreshel: switching would lose data that cannot be migrated, or would remove something Kreshel relies on that cannot be re-added on top. Do the same as a last resort when checks or the build still fail after real attempts to fix them. Then leave `main` clean at its last good commit (abort the merge), keep the stable app running, and call `request_human` with a short markdown summary and options for each way forward.

## Ship to stable

`scripts/fork/stable-app.sh`:

- `build [ref]` builds `main` (or `ref`) in the build worktree. Needs Rust (`cargo`, found automatically).
- `restart` quits, installs the last build, and reopens. Safe to run from a chat inside the app.
- `relaunch` quits, backs up, and reopens the installed app without installing. Use it when the running app is not the installed build (`restart` now checks this itself).
- `ship [ref]` runs `build`, then `restart`.
- `install` alone refuses while the app runs; Kreshel can use it from Terminal after ⌘Q.
- `rollback` swaps back to the previous app. `backup` and `status` do what they say.

Chats and boards (`~/.t3/userdata`) and folders (the active `t3code-v2` profile) must remain available across installs. Backups go to `~/.t3/backups/`; confirm coverage before relying on them. A newer build may change the database or Electron profile on first launch, so prepare preservation of both server and client state before restarting. Keep the old data and profile available for recovery.
