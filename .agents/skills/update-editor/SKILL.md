---
name: update-editor
description: Develop, test, and ship changes to Kreshel's T3 Code fork (the editor they work in daily). Use when asked to change or fix T3 Code / "the editor" in this repo, start or restart the dev instance, refresh dev test data, or rebuild and install the stable app after merging to main. For pulling official upstream changes, use update-t3.
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
5. Stop only processes you started, by PID. If Kreshel started the dev app, ask before stopping it.
6. Verify with targeted `pnpm exec tsc --noEmit` (in `apps/web`), `pnpm exec vp test run <files>`, and `pnpm exec vp lint <files>`. No repo-wide checks.

Refresh dev data only with the dev app stopped: move the old `~/.t3/dev/state.sqlite*` into `~/.t3/backups/`, then snapshot with
`sqlite3 -readonly ~/.t3/userdata/state.sqlite "VACUUM INTO '$HOME/.t3/dev/state.sqlite'"`. Never copy `environment-id`.

## Branches

- `upstream` is the official `pingdotgg/t3code` (pull only); `origin` is the fork `drKreshel/t3code`.
- `main` is the fork's stable line: upstream plus merged fork features. To take upstream changes, merge `upstream/main` into `main` (see `update-t3`).
- Commit finished work and upstream merges on the right branch with conventional messages. Ask before pushing to `origin`; never push to `upstream`.
- Keep fork changes merge-friendly: logic in new files, thin hooks into upstream files.

## Ship to stable

Once the change is on `main` (merged feature or upstream update):

1. `scripts/fork/stable-app.sh build` builds `main` in the build worktree (needs Rust: `cargo`). Takes a few minutes; the stable app keeps running.
2. Kreshel quits T3 Code (⌘Q), which ends chats running inside it, then runs `scripts/fork/stable-app.sh install` from Terminal. Install refuses while the app runs, backs up chats and folders to `~/.t3/backups/`, and keeps the previous app for `rollback`.
3. Chats (`~/.t3/userdata`) and folders (the `t3code` profile) stay in place across installs. A newer build may migrate the database on first launch; the backup is the way back.

`scripts/fork/stable-app.sh status` shows `main`, `upstream/main`, the last build, and the installed app.
