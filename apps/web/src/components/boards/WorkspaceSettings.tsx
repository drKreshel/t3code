import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import {
  planWorkspace,
  type ProjectRepos,
  type WorkspaceCheckout,
  type WorkspaceRepoRule,
  type WorkspaceRules,
  type WorkspaceScope,
} from "@t3tools/contracts";
import { FolderGit2Icon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { readLocalApi } from "../../localApi";
import {
  rulesOf,
  useProjectRepos,
  useWorkspaces,
  useWorkspacesDispatch,
  workspaceOf,
} from "../../state/workspaces";
import { Badge } from "../ui/badge";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const INHERIT = "inherit";

const CHECKOUT_LABEL: Record<WorkspaceCheckout | typeof INHERIT, string> = {
  inherit: "Inherit",
  worktree: "Worktree",
  local: "Local checkout",
  skip: "Skip",
};

type Layer = Pick<WorkspaceRules, "defaults" | "repos">;
const EMPTY_LAYER: Layer = { defaults: {}, repos: [] };

interface RowFields {
  readonly checkout?: WorkspaceCheckout | undefined;
  readonly startFrom?: string | undefined;
}

/** A layer's value for one row; `*` is the row for every repo. */
function rowValue(layer: Layer, repo: string): RowFields {
  if (repo === "*") return layer.defaults;
  return layer.repos.find((rule) => rule.repo === repo) ?? {};
}

/** Only the fields that are set, so an unset field inherits. */
function compact(fields: RowFields): { checkout?: WorkspaceCheckout; startFrom?: string } {
  return {
    ...(fields.checkout !== undefined ? { checkout: fields.checkout } : {}),
    ...(fields.startFrom ? { startFrom: fields.startFrom } : {}),
  };
}

function withRow(layer: Layer, repo: string, patch: RowFields): Layer {
  const next = compact({ ...rowValue(layer, repo), ...patch });
  if (repo === "*") return { ...layer, defaults: next };
  const others = layer.repos.filter((rule) => rule.repo !== repo);
  const keep = next.checkout !== undefined || next.startFrom !== undefined;
  const rule: WorkspaceRepoRule = { repo, ...next };
  return { ...layer, repos: keep ? [...others, rule] : others };
}

/**
 * Edits one layer of workspace rules (project, board, or ticket). Empty
 * fields inherit from the layer before; the summary shows what a ticket gets.
 */
export function WorkspaceRulesEditor({
  scope,
  scopeId,
  projectKey,
  earlierLayers,
}: {
  readonly scope: WorkspaceScope;
  readonly scopeId: string;
  readonly projectKey: string | null;
  /** The layers this one overrides, for the summary. */
  readonly earlierLayers: ReadonlyArray<Layer | undefined>;
}) {
  const snapshot = useWorkspaces();
  const dispatch = useWorkspacesDispatch();
  const repos = useProjectRepos(projectKey);
  const layer: Layer = rulesOf(snapshot, scope, scopeId) ?? EMPTY_LAYER;

  if (projectKey === null) {
    return <p className="text-sm text-muted-foreground">Set a project first.</p>;
  }
  if (repos === null) return <p className="text-sm text-muted-foreground">Reading the project…</p>;
  if (repos.kind === "none") {
    return (
      <p className="text-sm text-muted-foreground">
        This project is not a git repo and holds none, so tickets run in its folder as it is.
      </p>
    );
  }

  const save = (next: Layer) =>
    void dispatch({
      type: "rules.set",
      scope,
      scopeId,
      defaults: next.defaults,
      repos: next.repos,
    });
  const rows = repos.kind === "repo" ? ["*"] : ["*", ...repos.repos];
  const plan = planWorkspace(repos, [...earlierLayers, layer]);

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1.5">
        {rows.map((repo) => (
          <RuleRow
            key={repo}
            label={repo === "*" ? (repos.kind === "repo" ? "This repo" : "All repos") : repo}
            value={rowValue(layer, repo)}
            allowSkip={repos.kind === "folder"}
            onChange={(patch) => save(withRow(layer, repo, patch))}
          />
        ))}
      </ul>
      <WorkspacePlanSummary repos={repos} plan={plan} />
    </div>
  );
}

function RuleRow({
  label,
  value,
  allowSkip,
  onChange,
}: {
  readonly label: string;
  readonly value: RowFields;
  readonly allowSkip: boolean;
  readonly onChange: (patch: RowFields) => void;
}) {
  const [startFrom, setStartFrom] = useState(value.startFrom ?? "");
  const options: Array<WorkspaceCheckout | typeof INHERIT> = allowSkip
    ? [INHERIT, "worktree", "local", "skip"]
    : [INHERIT, "worktree", "local"];
  const current = value.checkout ?? INHERIT;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_9rem_10rem] items-center gap-2 text-sm">
      <span className="min-w-0 truncate font-mono text-xs">{label}</span>
      <Select
        value={current}
        onValueChange={(next) =>
          onChange({ checkout: next === INHERIT ? undefined : (next as WorkspaceCheckout) })
        }
      >
        <SelectTrigger size="sm" aria-label={`Checkout for ${label}`}>
          <SelectValue>{CHECKOUT_LABEL[current]}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {CHECKOUT_LABEL[option]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Input
        size="sm"
        aria-label={`Start branch for ${label}`}
        placeholder="Start from: inherit"
        value={startFrom}
        onChange={(event) => setStartFrom(event.target.value)}
        onBlur={() => {
          if (startFrom.trim() !== (value.startFrom ?? "")) {
            onChange({ startFrom: startFrom.trim() || undefined });
          }
        }}
      />
    </li>
  );
}

function WorkspacePlanSummary({
  repos,
  plan,
}: {
  readonly repos: ProjectRepos;
  readonly plan: ReturnType<typeof planWorkspace>;
}) {
  if (plan.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {repos.kind === "folder"
          ? "Tickets get no workspace yet: set at least one repo to Worktree or Local."
          : "Tickets run in the project checkout."}
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      A ticket gets:{" "}
      {plan
        .map((entry) =>
          entry.checkout === "local"
            ? `${entry.repo === "." ? "the repo" : entry.repo} (shared main checkout)`
            : `${entry.repo === "." ? "a worktree" : entry.repo} from ${entry.startFrom ?? "the remote's default branch"}`,
        )
        .join(", ")}
      .
    </p>
  );
}

/** The ticket page's workspace: where its chats run, and the way to remove it. */
export function TicketWorkspaceSection({
  ticketId,
  boardId,
  projectKey,
  readOnly,
}: {
  readonly ticketId: string;
  readonly boardId: string;
  readonly projectKey: string | null;
  readonly readOnly: boolean;
}) {
  const snapshot = useWorkspaces();
  const dispatch = useWorkspacesDispatch();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const workspace = workspaceOf(snapshot, ticketId);
  const overridden = rulesOf(snapshot, "ticket", ticketId) !== undefined;

  const remove = async () => {
    setBusy(true);
    const first = await dispatch({ type: "workspace.remove", ticketId }, { quiet: true });
    if (first && !first.ok && first.code === "unsaved") {
      const api = readLocalApi();
      const confirmed = api
        ? await settlePromise(() =>
            api.dialogs.confirm(`Remove the workspace anyway?\n${first.message}`, {
              variant: "destructive",
            }),
          )
        : null;
      if (confirmed?._tag === "Success" && confirmed.value) {
        await dispatch({ type: "workspace.remove", ticketId, force: true });
      }
    } else if (first && !first.ok) {
      toastManager.add({
        type: "error",
        title: "Could not remove the workspace",
        description: first.message,
      });
    }
    setBusy(false);
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium text-foreground">Workspace</h2>
        {overridden ? (
          <Badge variant="outline" size="sm">
            Overridden
          </Badge>
        ) : null}
        {!readOnly ? (
          <div className="ml-auto flex items-center gap-1">
            <Button size="xs" variant="ghost" onClick={() => setEditing((value) => !value)}>
              {editing ? "Done" : "Override"}
            </Button>
            {workspace ? (
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => void remove()}>
                <Trash2Icon />
                Remove workspace
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {workspace ? (
        <ul className="flex flex-col gap-1 rounded-lg border border-border/60 px-3 py-2 text-sm">
          <li className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <FolderGit2Icon className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate font-mono">{workspace.path}</span>
          </li>
          {workspace.repos.map((repo) => (
            <li key={repo.repo} className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate font-mono text-xs">
                {repo.repo === "." ? "repo" : repo.repo}
              </span>
              {repo.checkout === "worktree" ? (
                <span className="text-xs text-muted-foreground">
                  {repo.branch}
                  {repo.startFrom ? ` from ${repo.startFrom}` : ""}
                </span>
              ) : (
                <Badge variant="warning" size="sm">
                  Shared main checkout
                </Badge>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No workspace yet. It is created when a chat on this ticket needs one.
        </p>
      )}
      {editing ? (
        <div className="rounded-lg border border-border/60 p-3">
          <p className="mb-2 text-xs text-muted-foreground">
            This ticket's settings override its board's and project's. Changes apply the next time
            the workspace is created.
          </p>
          <TicketRulesEditor ticketId={ticketId} boardId={boardId} projectKey={projectKey} />
        </div>
      ) : null}
    </section>
  );
}

function TicketRulesEditor({
  ticketId,
  boardId,
  projectKey,
}: {
  readonly ticketId: string;
  readonly boardId: string;
  readonly projectKey: string | null;
}) {
  const snapshot = useWorkspaces();
  return (
    <WorkspaceRulesEditor
      scope="ticket"
      scopeId={ticketId}
      projectKey={projectKey}
      earlierLayers={[
        rulesOf(snapshot, "project", projectKey),
        rulesOf(snapshot, "board", boardId),
      ]}
    />
  );
}
