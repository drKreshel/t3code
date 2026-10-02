/**
 * Ticket workspaces: one folder per ticket that every chat on the ticket runs
 * in. Knows only git: native worktrees on the ticket's branch, created when a
 * chat first needs them and reused after. Databases, ports, and other
 * environment setup stay with each project's own setup script, which runs in
 * a new workspace like it does for any T3 worktree.
 *
 * For a project folder holding several repos, the workspace mirrors that
 * folder: included repos become worktrees (or links to the main checkout for
 * `local`), and the folder's other top-level entries (agent instructions,
 * scripts, config) are linked in so the chat sees the project as it is.
 */
import {
  type ProjectRepos,
  ProjectId,
  type TicketWorkspace,
  type TicketWorkspaceRepo,
  TicketWorkspaceRepo as TicketWorkspaceRepoSchema,
  type WorkspaceRules,
  WorkspaceRules as WorkspaceRulesSchema,
  type WorkspacesCommand,
  WorkspacesCommandError,
  type WorkspacesCommandResult,
  type WorkspacesSnapshot,
  WorkspaceScope,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import { BoardsService } from "../boards/BoardsService.ts";
import * as ForkDatabase from "../ForkDatabase.ts";
import {
  planWorkspace,
  safeFolderName,
  ticketBranch,
  ticketSlug,
  unsavedWork,
} from "./workspaceLogic.ts";

const RulesJson = Schema.fromJsonString(
  Schema.Struct({
    defaults: WorkspaceRulesSchema.fields.defaults,
    repos: WorkspaceRulesSchema.fields.repos,
  }),
);
const ReposJson = Schema.fromJsonString(Schema.Array(TicketWorkspaceRepoSchema));
const decodeRules = Schema.decodeUnknownSync(RulesJson);
const encodeRules = Schema.encodeSync(RulesJson);
const decodeRepos = Schema.decodeUnknownSync(ReposJson);
const encodeRepos = Schema.encodeSync(ReposJson);
const isScope = Schema.is(WorkspaceScope);
const isWorkspacesCommandError = Schema.is(WorkspacesCommandError);

/** Top-level entries of a project folder that are never linked into a workspace. */
const UNLINKED_ENTRIES = new Set([".DS_Store", ".git"]);

type WorkspaceError = WorkspacesCommandError;
const fail = (code: WorkspacesCommandError["code"], message: string) =>
  new WorkspacesCommandError({ code, message });

export class TicketWorkspaces extends Context.Service<
  TicketWorkspaces,
  {
    readonly snapshot: Effect.Effect<WorkspacesSnapshot, WorkspaceError>;
    readonly stream: Stream.Stream<WorkspacesSnapshot, WorkspaceError>;
    readonly listRepos: (projectKey: string) => Effect.Effect<ProjectRepos, WorkspaceError>;
    readonly dispatch: (
      command: WorkspacesCommand,
    ) => Effect.Effect<WorkspacesCommandResult, WorkspaceError>;
    /** The ticket's current workspace, if it has one that was not removed. */
    readonly find: (ticketId: string) => Effect.Effect<TicketWorkspace | null, WorkspaceError>;
  }
>()("t3/fork/workspaces/TicketWorkspaces") {}

interface WorkspaceRow {
  readonly ticket_id: string;
  readonly project_key: string;
  readonly path: string;
  readonly repos_json: string;
  readonly created_at: string;
  readonly removed_at: string | null;
}

const toWorkspace = (row: WorkspaceRow): TicketWorkspace => ({
  ticketId: row.ticket_id,
  projectKey: row.project_key,
  path: row.path,
  repos: decodeRepos(row.repos_json),
  createdAt: row.created_at,
  removedAt: row.removed_at,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const boards = yield* BoardsService;
  const { worktreesDir } = yield* ServerConfig;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const setupRunner = yield* Effect.serviceOption(
    ProjectSetupScriptRunner.ProjectSetupScriptRunner,
  );
  const changes = yield* PubSub.unbounded<void>();
  // One workspace change at a time: two chats starting on one ticket must not
  // both create its worktrees.
  const lock = yield* Semaphore.make(1);
  const ticketsRoot = path.join(worktreesDir, "tickets");
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const storage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isWorkspacesCommandError(cause)
          ? cause
          : fail("storage", cause instanceof Error ? cause.message : "Workspace storage failed."),
      ),
    );
  const gitError = (what: string) => (cause: unknown) =>
    fail("git", `${what}: ${cause instanceof Error ? cause.message : String(cause)}`);
  const fsError = (what: string) => (cause: unknown) =>
    fail("storage", `${what}: ${cause instanceof Error ? cause.message : String(cause)}`);
  const announce = PubSub.publish(changes, undefined);

  // ---------------------------------------------------------------------------
  // Lookups

  const projectRoot = (projectKey: string) =>
    Effect.gen(function* () {
      const separator = projectKey.indexOf(":");
      if (projectKey.slice(0, separator) !== environmentId) {
        return yield* fail("invalid", "The project is on another environment.");
      }
      const project = yield* projects
        .getShell(ProjectId.make(projectKey.slice(separator + 1)))
        .pipe(Effect.mapError(() => fail("storage", "Could not read the project.")));
      if (Option.isNone(project)) return yield* fail("not-found", "The project no longer exists.");
      return { id: project.value.id, root: project.value.workspaceRoot };
    });

  const listReposAt = (root: string) =>
    Effect.gen(function* () {
      if (yield* git.isRepository(root).pipe(Effect.orElseSucceed(() => false))) {
        return { kind: "repo", repos: [] } satisfies ProjectRepos;
      }
      const entries = yield* fs
        .readDirectory(root)
        .pipe(Effect.mapError(fsError("Could not read the project folder")));
      const repos: string[] = [];
      for (const entry of entries.toSorted()) {
        if (entry.startsWith(".")) continue;
        if (
          yield* fs.exists(path.join(root, entry, ".git")).pipe(Effect.orElseSucceed(() => false))
        ) {
          repos.push(entry);
        }
      }
      return { kind: repos.length > 0 ? "folder" : "none", repos } satisfies ProjectRepos;
    });

  const listRepos = (projectKey: string) =>
    projectRoot(projectKey).pipe(Effect.flatMap(({ root }) => listReposAt(root)));

  const rulesFor = (scope: string, scopeId: string | null) =>
    scopeId === null
      ? Effect.succeed(undefined)
      : storage(
          sql<{ readonly rules_json: string }>`
            SELECT rules_json FROM fork_workspace_rules
            WHERE scope = ${scope} AND scope_id = ${scopeId}
          `,
        ).pipe(Effect.map((rows) => (rows[0] ? decodeRules(rows[0].rules_json) : undefined)));

  const findRow = (ticketId: string) =>
    storage(
      sql<WorkspaceRow>`SELECT * FROM fork_ticket_workspaces WHERE ticket_id = ${ticketId}`,
    ).pipe(Effect.map((rows) => rows[0]));

  const find = (ticketId: string) =>
    findRow(ticketId).pipe(
      Effect.map((row) => (row && row.removed_at === null ? toWorkspace(row) : null)),
    );

  const ticketContext = (ticketId: string) =>
    Effect.gen(function* () {
      const snapshot = yield* boards.snapshot.pipe(
        Effect.mapError((error) => fail("storage", error.message)),
      );
      const ticket = snapshot.tickets.find((candidate) => candidate.id === ticketId);
      const board = snapshot.boards.find((candidate) => candidate.id === ticket?.boardId);
      if (!ticket || !board) return yield* fail("not-found", "That ticket no longer exists.");
      const projectKey = ticket.projectKey ?? board.defaultProjectKey;
      if (projectKey === null) {
        return yield* fail(
          "invalid",
          "The ticket has no project: set one on the ticket or a default on its board.",
        );
      }
      return { ticket, board, key: `${board.key}-${ticket.number}`, projectKey };
    });

  // ---------------------------------------------------------------------------
  // Creating

  /** The ref a new ticket branch starts from; bare names fall back to `origin/<name>`. */
  const resolveStart = (repoRoot: string, startFrom: string | null) =>
    Effect.gen(function* () {
      const resolves = (refName: string) =>
        git.hasCommit({ cwd: repoRoot, refName }).pipe(Effect.orElseSucceed(() => false));
      // Fresh remote refs, so a ticket does not start from a stale branch.
      yield* git.fetchRemote({ cwd: repoRoot, remoteName: "origin" }).pipe(Effect.ignore);
      if (startFrom !== null) {
        if (yield* resolves(startFrom)) return startFrom;
        if (yield* resolves(`origin/${startFrom}`)) return `origin/${startFrom}`;
        return yield* fail(
          "git",
          `${path.basename(repoRoot)} has no branch "${startFrom}" to start from.`,
        );
      }
      if (yield* resolves("origin/HEAD")) return "origin/HEAD";
      return "HEAD";
    });

  /** A worktree of `repoRoot` at `worktreePath` on the ticket's branch. */
  const createWorktree = (
    repoRoot: string,
    worktreePath: string,
    branch: string,
    startFrom: string | null,
  ) =>
    Effect.gen(function* () {
      if (
        yield* fs.exists(path.join(worktreePath, ".git")).pipe(Effect.orElseSucceed(() => false))
      ) {
        return; // Still there from before.
      }
      // Recreating after a removal: the branch kept the work.
      const branchExists = yield* git
        .hasCommit({ cwd: repoRoot, refName: `refs/heads/${branch}` })
        .pipe(Effect.orElseSucceed(() => false));
      if (branchExists) {
        yield* git.pruneWorktrees({ cwd: repoRoot }).pipe(Effect.ignore);
        yield* git
          .createWorktree({ cwd: repoRoot, refName: branch, path: worktreePath })
          .pipe(
            Effect.mapError(
              gitError(`Could not recreate the worktree of ${path.basename(repoRoot)}`),
            ),
          );
        return;
      }
      const base = yield* resolveStart(repoRoot, startFrom);
      yield* git
        .createWorktree({ cwd: repoRoot, refName: base, newRefName: branch, path: worktreePath })
        .pipe(
          Effect.mapError(gitError(`Could not create a worktree of ${path.basename(repoRoot)}`)),
        );
    });

  const linkIfMissing = (target: string, link: string) =>
    Effect.gen(function* () {
      if (yield* fs.exists(link).pipe(Effect.orElseSucceed(() => false))) return;
      yield* fs.symlink(target, link).pipe(Effect.mapError(fsError(`Could not link ${link}`)));
    });

  const runSetup = (threadId: string, projectId: string, workspacePath: string) =>
    Effect.gen(function* () {
      if (Option.isNone(setupRunner)) return;
      const result = yield* setupRunner.value.runForThread({
        threadId,
        projectId,
        worktreePath: workspacePath,
        observeCompletion: {},
      });
      // A script marked async lets the chat start while it runs.
      if (result.status === "started" && !result.async && result.completion) {
        yield* result.completion;
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Ticket workspace setup script failed", { cause }),
      ),
    );

  const ensure = (ticketId: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const context = yield* ticketContext(ticketId);
        const existing = yield* findRow(ticketId);
        const { root } = yield* projectRoot(context.projectKey);
        const branch = ticketBranch(context.key);
        const live =
          existing !== undefined &&
          existing.removed_at === null &&
          (yield* fs.exists(existing.path).pipe(Effect.orElseSucceed(() => false)));
        if (live && existing.project_key !== context.projectKey) {
          // Its worktrees belong to the old project's repos; building over them would mix both.
          return yield* fail(
            "invalid",
            "The ticket's workspace was made for another project. Remove the workspace to start one in the new project.",
          );
        }
        if (live) {
          const workspace = toWorkspace(existing);
          // The branch git has, which a later board key change does not rename.
          const single = workspace.repos.length === 1 && workspace.repos[0]!.repo === ".";
          return {
            path: workspace.path,
            branch: single ? workspace.repos[0]!.branch : null,
            created: false,
          };
        }

        const project = yield* listReposAt(root);
        if (project.kind === "none") {
          return yield* fail(
            "no-workspace",
            "This project is not a git repo and holds none, so tickets work in the project checkout.",
          );
        }
        const plan = planWorkspace(project, [
          yield* rulesFor("project", context.projectKey),
          yield* rulesFor("board", context.board.id),
          yield* rulesFor("ticket", ticketId),
        ]);
        if (plan.length === 0) {
          return yield* fail(
            "invalid",
            "Pick the repos this ticket works on, in the board's or the ticket's workspace settings.",
          );
        }
        const folder = path.join(
          ticketsRoot,
          safeFolderName(path.basename(root)),
          ticketSlug(context.key),
        );
        const repos: TicketWorkspaceRepo[] = [];

        if (project.kind === "repo") {
          const planned = plan[0]!;
          if (planned.checkout === "local") {
            return yield* fail(
              "no-workspace",
              "This ticket uses a local checkout, so it works in the project checkout.",
            );
          }
          yield* fs
            .makeDirectory(path.dirname(folder), { recursive: true })
            .pipe(Effect.mapError(fsError("Could not create the workspace folder")));
          yield* createWorktree(root, folder, branch, planned.startFrom);
          repos.push({
            repo: ".",
            checkout: "worktree",
            path: folder,
            source: root,
            branch,
            startFrom: planned.startFrom,
          });
        } else {
          yield* fs
            .makeDirectory(folder, { recursive: true })
            .pipe(Effect.mapError(fsError("Could not create the workspace folder")));
          // Everything that is not a repo (instructions, scripts, config) is
          // shared as is; repos not in the plan stay out.
          const entries = yield* fs
            .readDirectory(root)
            .pipe(Effect.mapError(fsError("Could not read the project folder")));
          for (const entry of entries) {
            if (UNLINKED_ENTRIES.has(entry) || project.repos.includes(entry)) continue;
            yield* linkIfMissing(path.join(root, entry), path.join(folder, entry));
          }
          for (const entry of plan) {
            const source = path.join(root, entry.repo);
            const target = path.join(folder, entry.repo);
            if (entry.checkout === "local") {
              yield* linkIfMissing(source, target);
            } else {
              yield* createWorktree(source, target, branch, entry.startFrom);
            }
            repos.push({
              repo: entry.repo,
              checkout: entry.checkout,
              path: target,
              source,
              branch: entry.checkout === "worktree" ? branch : null,
              startFrom: entry.checkout === "worktree" ? entry.startFrom : null,
            });
          }
        }

        const at = yield* nowIso;
        yield* storage(sql`
          INSERT INTO fork_ticket_workspaces (ticket_id, project_key, path, repos_json, created_at, removed_at)
          VALUES (${ticketId}, ${context.projectKey}, ${folder}, ${encodeRepos(repos)}, ${at}, NULL)
          ON CONFLICT (ticket_id) DO UPDATE SET project_key = excluded.project_key,
            path = excluded.path, repos_json = excluded.repos_json,
            created_at = excluded.created_at, removed_at = NULL
        `);
        yield* announce;
        return { path: folder, branch: project.kind === "repo" ? branch : null, created: true };
      }),
    );

  // ---------------------------------------------------------------------------
  // Removing

  const remove = (ticketId: string, force: boolean) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const row = yield* findRow(ticketId);
        if (!row || row.removed_at !== null) return;
        const workspace = toWorkspace(row);
        const worktrees = workspace.repos.filter((repo) => repo.checkout === "worktree");
        if (!force) {
          const problems: string[] = [];
          for (const repo of worktrees) {
            if (!(yield* fs.exists(repo.path).pipe(Effect.orElseSucceed(() => false)))) continue;
            const status = yield* git
              .status({ cwd: repo.path })
              .pipe(Effect.mapError(gitError(`Could not read the status of ${repo.repo}`)));
            const problem = unsavedWork(status);
            if (problem) problems.push(`${repo.repo === "." ? "the repo" : repo.repo}: ${problem}`);
          }
          // In a folder of repos, anything made beside them (not a link, not a
          // worktree) exists only here and would go with the folder.
          if (!(workspace.repos.length === 1 && workspace.repos[0]!.repo === ".")) {
            const repoNames = new Set(workspace.repos.map((repo) => repo.repo));
            const entries = yield* fs
              .readDirectory(workspace.path)
              .pipe(Effect.orElseSucceed((): string[] => []));
            for (const entry of entries) {
              if (repoNames.has(entry) || UNLINKED_ENTRIES.has(entry)) continue;
              const isLink = yield* fs.readLink(path.join(workspace.path, entry)).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              );
              if (!isLink) problems.push(`${entry}: only in the workspace folder`);
            }
          }
          if (problems.length > 0) {
            return yield* fail(
              "unsaved",
              `The workspace has work that is not saved anywhere else (${problems.join("; ")}). Commit and push it, or remove anyway.`,
            );
          }
        }
        for (const repo of worktrees) {
          if (!(yield* fs.exists(repo.path).pipe(Effect.orElseSucceed(() => false)))) continue;
          yield* git
            .removeWorktree({ cwd: repo.source, path: repo.path, force: true })
            .pipe(Effect.mapError(gitError(`Could not remove the worktree of ${repo.repo}`)));
        }
        // The folder only ever holds links and worktrees made here; never
        // delete anything outside the tickets root.
        if (workspace.path.startsWith(`${ticketsRoot}${path.sep}`)) {
          yield* fs.remove(workspace.path, { recursive: true }).pipe(Effect.ignore);
        }
        yield* storage(
          sql`UPDATE fork_ticket_workspaces SET removed_at = ${yield* nowIso} WHERE ticket_id = ${ticketId}`,
        );
        yield* announce;
      }),
    );

  // ---------------------------------------------------------------------------
  // Rules, snapshot, dispatch

  const setRules = (rules: Pick<WorkspaceRules, "scope" | "scopeId" | "defaults" | "repos">) =>
    Effect.gen(function* () {
      const empty =
        rules.repos.length === 0 &&
        rules.defaults.checkout === undefined &&
        rules.defaults.startFrom === undefined;
      if (empty) {
        yield* storage(sql`
          DELETE FROM fork_workspace_rules WHERE scope = ${rules.scope} AND scope_id = ${rules.scopeId}
        `);
      } else {
        const json = encodeRules({ defaults: rules.defaults, repos: rules.repos });
        const at = yield* nowIso;
        yield* storage(sql`
          INSERT INTO fork_workspace_rules (scope, scope_id, rules_json, updated_at)
          VALUES (${rules.scope}, ${rules.scopeId}, ${json}, ${at})
          ON CONFLICT (scope, scope_id) DO UPDATE SET rules_json = excluded.rules_json,
            updated_at = excluded.updated_at
        `);
      }
      yield* announce;
    });

  const snapshot = Effect.gen(function* () {
    const ruleRows = yield* storage(
      sql<{ readonly scope: string; readonly scope_id: string; readonly rules_json: string }>`
        SELECT scope, scope_id, rules_json FROM fork_workspace_rules
      `,
    );
    const workspaceRows = yield* storage(sql<WorkspaceRow>`SELECT * FROM fork_ticket_workspaces`);
    return {
      rules: ruleRows.flatMap((row) =>
        isScope(row.scope)
          ? [{ scope: row.scope, scopeId: row.scope_id, ...decodeRules(row.rules_json) }]
          : [],
      ),
      workspaces: workspaceRows.map(toWorkspace),
    } satisfies WorkspacesSnapshot;
  });

  const stream = Stream.callback<WorkspacesSnapshot, WorkspaceError>(
    (mailbox) =>
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        Queue.offerUnsafe(mailbox, yield* snapshot);
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach(() =>
            snapshot.pipe(
              Effect.matchEffect({
                onFailure: (error) => Queue.fail(mailbox, error),
                onSuccess: (next) => Effect.sync(() => Queue.offerUnsafe(mailbox, next)),
              }),
            ),
          ),
          Effect.forkScoped,
        );
      }),
    { bufferSize: 1, strategy: "sliding" },
  );

  const noResult: WorkspacesCommandResult = { path: null, branch: null, created: false };

  const dispatch = (command: WorkspacesCommand) =>
    Effect.gen(function* () {
      switch (command.type) {
        case "rules.set":
          yield* setRules(command);
          return noResult;
        case "workspace.ensure":
          return yield* ensure(command.ticketId);
        case "workspace.setup": {
          const workspace = yield* find(command.ticketId);
          if (!workspace) return yield* fail("not-found", "The ticket has no workspace.");
          const { id } = yield* projectRoot(workspace.projectKey);
          yield* runSetup(command.threadId, id, workspace.path);
          return noResult;
        }
        case "workspace.remove":
          yield* remove(command.ticketId, command.force === true);
          return noResult;
      }
    });

  return TicketWorkspaces.of({ snapshot, stream, listRepos, dispatch, find });
});

export const layer = Layer.effect(TicketWorkspaces, make).pipe(Layer.provide(ForkDatabase.layer));

/** In-memory variant for tests. */
export const layerMemory = Layer.effect(TicketWorkspaces, make).pipe(
  Layer.provide(ForkDatabase.ForkDatabaseMemory),
);
