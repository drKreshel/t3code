---
name: update-t3
description: Update a T3 Code development checkout from upstream while preserving local work and isolated dev data. Use when asked to update dev code or catch up with T3 Code releases.
---

# Update T3 development code

Update the repository code only. Preserve this checkout's dev database, threads, settings, and other local state. Code updates do not synchronize threads with a desktop installation.

Inspect the current branch, worktree status, remotes, and any running dev process before changing anything. In this repository, `upstream/main` is the official T3 Code branch and `origin` is the contributor's fork; verify those names and URLs rather than assuming them. Fetch the selected upstream branch and report what changed. Default to the latest upstream/main unless the user selects another target. Integrate it into the intended local branch while preserving tracked and untracked work. Adapt fork features to upstream API, schema, and architecture changes as part of the update; the need for merging or adaptation alone is not a reason to stop at an older release. Never reset, clean, force-push, or overwrite local changes to make an update succeed. Resolve conflicts with the current feature's intent in mind; if that cannot be done safely, present the exact conflict and available choices.

Compare incoming upstream features with the fork’s custom features. Tell the user when upstream introduces an equivalent, a more complete alternative, or a change that could make a custom feature redundant. Explain the relevant capabilities, gaps, and migration costs so the user can choose whether to adopt upstream’s version. Preserve the custom feature while integrating unless the user authorizes replacing or retiring it.

Run `vp i` if dependencies or the lockfile changed. Use only focused checks for affected code. A running dev server may hot reload, but server and dependency changes can require a restart. Stop or restart only a process started and tracked by this task; otherwise tell the user what to restart. Do not run repository-wide checks. See [development](../../../docs/operations/development.md).

Report the code revision actually updated, plus any restart needed. Never run `migrate-dev-db` or replace `.t3/userdata` as part of this skill.
