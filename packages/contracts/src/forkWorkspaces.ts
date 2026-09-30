/**
 * Ticket workspaces (fork feature): each ticket gets one folder its chats run
 * in. For a project that is one git repo, that folder is a worktree; for a
 * project folder holding several repos, it holds a worktree (or a link to the
 * main checkout) per included repo. Which repos, how they are checked out, and
 * the branch they start from come from rules set per project, board, and
 * ticket, each overriding the one before.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const FORK_WORKSPACES_WS_METHODS = {
  subscribe: "fork.workspaces.subscribe",
  dispatch: "fork.workspaces.dispatch",
  listRepos: "fork.workspaces.listRepos",
} as const;

/**
 * How a repo appears in a ticket's workspace: its own worktree on the ticket's
 * branch, the main checkout as it is (shared by every ticket), or not at all.
 */
export const WorkspaceCheckout = Schema.Literals(["worktree", "local", "skip"]);
export type WorkspaceCheckout = typeof WorkspaceCheckout.Type;

/** Settings for one repo; omitted fields inherit from the layer before. */
export const WorkspaceRepoRule = Schema.Struct({
  /** Folder name inside the project; `.` for a project that is itself one repo. */
  repo: TrimmedNonEmptyString,
  checkout: Schema.optional(WorkspaceCheckout),
  /** Branch or ref a new ticket branch starts from, like `origin/base`. */
  startFrom: Schema.optional(TrimmedNonEmptyString),
});
export type WorkspaceRepoRule = typeof WorkspaceRepoRule.Type;

export const WorkspaceScope = Schema.Literals(["project", "board", "ticket"]);
export type WorkspaceScope = typeof WorkspaceScope.Type;

/** One layer of rules: defaults for every repo, then per-repo settings. */
export const WorkspaceRules = Schema.Struct({
  scope: WorkspaceScope,
  /** Scoped project key, board id, or ticket id. */
  scopeId: TrimmedNonEmptyString,
  defaults: Schema.Struct({
    checkout: Schema.optional(WorkspaceCheckout),
    startFrom: Schema.optional(TrimmedNonEmptyString),
  }),
  repos: Schema.Array(WorkspaceRepoRule),
});
export type WorkspaceRules = typeof WorkspaceRules.Type;

export const TicketWorkspaceRepo = Schema.Struct({
  repo: TrimmedNonEmptyString,
  checkout: Schema.Literals(["worktree", "local"]),
  /** Where the repo is inside the workspace. */
  path: TrimmedNonEmptyString,
  /** The repo's main checkout, which worktrees branch from and local repos link to. */
  source: TrimmedNonEmptyString,
  /** The ticket's branch for worktrees; null for local checkouts. */
  branch: Schema.NullOr(Schema.String),
  startFrom: Schema.NullOr(Schema.String),
});
export type TicketWorkspaceRepo = typeof TicketWorkspaceRepo.Type;

export const TicketWorkspace = Schema.Struct({
  ticketId: TrimmedNonEmptyString,
  projectKey: TrimmedNonEmptyString,
  /** The folder the ticket's chats run in. */
  path: TrimmedNonEmptyString,
  repos: Schema.Array(TicketWorkspaceRepo),
  createdAt: IsoDateTime,
  /** Set once removed; the next chat that needs it creates it again. */
  removedAt: Schema.NullOr(IsoDateTime),
});
export type TicketWorkspace = typeof TicketWorkspace.Type;

export const WorkspacesSnapshot = Schema.Struct({
  rules: Schema.Array(WorkspaceRules),
  workspaces: Schema.Array(TicketWorkspace),
});
export type WorkspacesSnapshot = typeof WorkspacesSnapshot.Type;

const command = <Type extends string, Fields extends Schema.Struct.Fields>(
  type: Type,
  fields: Fields,
) => Schema.Struct({ type: Schema.Literal(type), ...fields });

export const WorkspacesCommand = Schema.Union([
  /** Replaces one layer's rules; empty defaults and repos clear the layer. */
  command("rules.set", {
    scope: WorkspaceScope,
    scopeId: TrimmedNonEmptyString,
    defaults: WorkspaceRules.fields.defaults,
    repos: Schema.Array(WorkspaceRepoRule),
  }),
  /** Creates the ticket's workspace, or reuses it. */
  command("workspace.ensure", { ticketId: TrimmedNonEmptyString }),
  /**
   * Runs the project's worktree setup script in a new workspace, in the chat
   * that will work there. Send after ensure reported `created`.
   */
  command("workspace.setup", {
    ticketId: TrimmedNonEmptyString,
    threadId: TrimmedNonEmptyString,
  }),
  /** Removes the worktrees (branches stay). Refuses unsaved work unless forced. */
  command("workspace.remove", {
    ticketId: TrimmedNonEmptyString,
    force: Schema.optional(Schema.Boolean),
  }),
]);
export type WorkspacesCommand = typeof WorkspacesCommand.Type;

export const WorkspacesCommandResult = Schema.Struct({
  /** The workspace folder, for ensure. */
  path: Schema.NullOr(Schema.String),
  /** The ticket branch when the workspace is a single repo's worktree. */
  branch: Schema.NullOr(Schema.String),
  /** True when ensure created (or recreated) the workspace. */
  created: Schema.Boolean,
});
export type WorkspacesCommandResult = typeof WorkspacesCommandResult.Type;

export class WorkspacesCommandError extends Schema.TaggedError<WorkspacesCommandError>()(
  "WorkspacesCommandError",
  {
    code: Schema.Literals(["not-found", "invalid", "unsaved", "git", "storage"]),
    message: Schema.String,
  },
) {}

/** What a project folder is, and the repos T3 found in it. */
export const ProjectRepos = Schema.Struct({
  /** `repo`: the project is one git repo. `folder`: repos one level down. `none`: no git. */
  kind: Schema.Literals(["repo", "folder", "none"]),
  repos: Schema.Array(Schema.String),
});
export type ProjectRepos = typeof ProjectRepos.Type;

export const ForkWorkspacesSubscribeRpc = Rpc.make(FORK_WORKSPACES_WS_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: WorkspacesSnapshot,
  error: Schema.Union([WorkspacesCommandError, EnvironmentAuthorizationError]),
  stream: true,
});

export const ForkWorkspacesDispatchRpc = Rpc.make(FORK_WORKSPACES_WS_METHODS.dispatch, {
  payload: WorkspacesCommand,
  success: WorkspacesCommandResult,
  error: Schema.Union([WorkspacesCommandError, EnvironmentAuthorizationError]),
});

export const ForkWorkspacesListReposRpc = Rpc.make(FORK_WORKSPACES_WS_METHODS.listRepos, {
  payload: Schema.Struct({ projectKey: TrimmedNonEmptyString }),
  success: ProjectRepos,
  error: Schema.Union([WorkspacesCommandError, EnvironmentAuthorizationError]),
});

export interface PlannedRepo {
  readonly repo: string;
  readonly checkout: "worktree" | "local";
  /** Null: the repo's remote default branch. */
  readonly startFrom: string | null;
}

/**
 * The repos a ticket's workspace holds, with their checkout and start branch.
 * Layers apply in order (project, board, ticket): a layer's defaults apply to
 * every repo, then its per-repo rules; a later layer overrides an earlier one
 * field by field.
 *
 * Without rules, a single-repo project gets a worktree and a folder of repos
 * gets nothing: a folder can hold many repos, and a ticket should only carry
 * the ones it works on.
 */
export function planWorkspace(
  project: ProjectRepos,
  layers: ReadonlyArray<Pick<WorkspaceRules, "defaults" | "repos"> | undefined>,
): PlannedRepo[] {
  if (project.kind === "none") return [];
  const repos = project.kind === "repo" ? ["."] : project.repos;
  let defaultCheckout: WorkspaceCheckout = project.kind === "repo" ? "worktree" : "skip";
  let defaultStartFrom: string | undefined;
  const perRepo = new Map<string, { checkout?: WorkspaceCheckout; startFrom?: string }>();
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.defaults.checkout !== undefined) {
      defaultCheckout = layer.defaults.checkout;
      // A layer's default overrides earlier layers' per-repo checkouts too.
      for (const entry of perRepo.values()) delete entry.checkout;
    }
    if (layer.defaults.startFrom !== undefined) {
      defaultStartFrom = layer.defaults.startFrom;
      for (const entry of perRepo.values()) delete entry.startFrom;
    }
    for (const rule of layer.repos) {
      const entry = perRepo.get(rule.repo) ?? {};
      if (rule.checkout !== undefined) entry.checkout = rule.checkout;
      if (rule.startFrom !== undefined) entry.startFrom = rule.startFrom;
      perRepo.set(rule.repo, entry);
    }
  }
  return repos.flatMap((repo) => {
    const entry = perRepo.get(repo);
    const checkout = entry?.checkout ?? defaultCheckout;
    if (checkout === "skip") return [];
    return [{ repo, checkout, startFrom: entry?.startFrom ?? defaultStartFrom ?? null }];
  });
}
