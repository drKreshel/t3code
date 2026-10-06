import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { Automation, AutomationRun, AutomationRunStatus } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  PlayIcon,
  PlusIcon,
  ZapIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { useAutomations, useAutomationsDispatch } from "../../state/automations";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { readLocalApi } from "../../localApi";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { BoardsPageFrame, BoardsStatusMessage } from "../boards/BoardsPageFrame";
import { useProjectLookup } from "../boards/useTicketActions";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { AutomationDialog, type AutomationDraft } from "./AutomationDialog";
import { describeSchedule } from "./automations.logic";

const RUN_STATUS_VARIANT: Record<
  AutomationRunStatus,
  "info" | "success" | "error" | "warning" | "outline"
> = {
  queued: "outline",
  running: "info",
  succeeded: "success",
  failed: "error",
  missed: "warning",
  skipped: "warning",
};

const TEMPLATES: ReadonlyArray<{ readonly label: string; readonly draft: AutomationDraft }> = [
  {
    label: "Weekly dependency audit",
    draft: {
      title: "Weekly dependency audit",
      prompt:
        "Check this project for outdated or vulnerable dependencies. Summarize what should be upgraded and why, and open a pull request for safe patch and minor upgrades.",
      repeat: "weekly",
    },
  },
  {
    label: "Weekday standup summary",
    draft: {
      title: "Standup summary",
      prompt:
        "Summarize what changed in this project since yesterday (commits, open pull requests) and list the board tickets that need my attention today.",
      repeat: "weekdays",
    },
  },
];

/** Scheduled automations, with their run history. */
export function AutomationsPage() {
  const automations = useAutomations();
  const [dialog, setDialog] = useState<{
    readonly automation: Automation | null;
    readonly draft: AutomationDraft | null;
  } | null>(null);

  const content = () => {
    if (automations.status === "loading") {
      return <BoardsStatusMessage>Loading automations…</BoardsStatusMessage>;
    }
    if (automations.status === "unavailable") {
      return (
        <BoardsStatusMessage>
          Automations are unavailable. They need this computer's own server to be running.
        </BoardsStatusMessage>
      );
    }
    const { snapshot } = automations;
    return (
      <WorkspacePageContainer width="wide">
        {snapshot.automations.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ZapIcon />
              </EmptyMedia>
              <EmptyTitle>No automations yet</EmptyTitle>
              <EmptyDescription>Start a chat or perform cleanup on a schedule.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-foreground">Scheduled</h2>
            <ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60">
              {snapshot.automations.map((automation) => (
                <AutomationRow
                  key={automation.id}
                  automation={automation}
                  runs={snapshot.runs.filter((run) => run.automationId === automation.id)}
                  onEdit={() => setDialog({ automation, draft: null })}
                />
              ))}
            </ul>
          </section>
        )}
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">Start from a template</h2>
          <div className="flex flex-wrap gap-2">
            {TEMPLATES.map((template) => (
              <Button
                key={template.label}
                size="xs"
                variant="outline"
                onClick={() => setDialog({ automation: null, draft: template.draft })}
              >
                {template.label}
              </Button>
            ))}
          </div>
        </section>
      </WorkspacePageContainer>
    );
  };

  return (
    <BoardsPageFrame
      root="Automations"
      crumbs={[]}
      actions={
        automations.status === "ready" ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => setDialog({ automation: null, draft: null })}
          >
            <PlusIcon />
            New automation
          </Button>
        ) : null
      }
    >
      {content()}
      <AutomationDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        automation={dialog?.automation ?? null}
        draft={dialog?.draft ?? null}
      />
    </BoardsPageFrame>
  );
}

function AutomationRow({
  automation,
  runs,
  onEdit,
}: {
  readonly automation: Automation;
  /** Newest first. */
  readonly runs: ReadonlyArray<AutomationRun>;
  readonly onEdit: () => void;
}) {
  const dispatch = useAutomationsDispatch();
  const lookupProject = useProjectLookup();
  const [expanded, setExpanded] = useState(false);
  const project = lookupProject(automation.action.projectKey);
  const last = runs[0];

  const remove = async () => {
    const api = readLocalApi();
    if (!api) return;
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(`Delete "${automation.title}"?\nIts run history is deleted too.`, {
        variant: "destructive",
      }),
    );
    if (confirmed._tag === "Success" && confirmed.value) {
      void dispatch({ type: "automation.delete", automationId: automation.id });
    }
  };

  return (
    <li className="flex flex-col">
      <div className="flex min-w-0 items-center gap-3 px-3 py-2.5 text-sm">
        <Switch
          checked={automation.enabled}
          aria-label={
            automation.enabled ? `Disable ${automation.title}` : `Enable ${automation.title}`
          }
          onCheckedChange={(enabled) =>
            void dispatch({ type: "automation.update", automationId: automation.id, enabled })
          }
        />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="flex min-w-0 flex-col">
            <span
              className={cn("truncate font-medium", !automation.enabled && "text-muted-foreground")}
            >
              {automation.title}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {describeSchedule(automation.trigger.schedule)} ({automation.trigger.timezone})
              {project ? ` · ${project.title}` : ""}
            </span>
          </span>
        </button>
        <span className="hidden shrink-0 flex-col items-end gap-0.5 text-xs text-muted-foreground sm:flex">
          {automation.enabled && automation.nextRunAt ? (
            <span>Next {new Date(automation.nextRunAt).toLocaleString()}</span>
          ) : null}
          {last ? (
            <Badge variant={RUN_STATUS_VARIANT[last.status]} size="sm">
              {last.status}{" "}
              {formatRelativeTimeLabel(last.finishedAt ?? last.startedAt ?? last.createdAt)}
            </Badge>
          ) : null}
        </span>
        <Menu>
          <MenuTrigger
            render={
              <Button
                aria-label={`Actions for ${automation.title}`}
                size="icon-xs"
                variant="ghost"
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              onClick={() =>
                void dispatch({ type: "automation.runNow", automationId: automation.id })
              }
            >
              <PlayIcon />
              Run now
            </MenuItem>
            <MenuItem onClick={onEdit}>Edit</MenuItem>
            <MenuSeparator />
            <MenuItem onClick={() => void remove()}>Delete</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {expanded ? <RunHistory runs={runs} /> : null}
    </li>
  );
}

function RunHistory({ runs }: { readonly runs: ReadonlyArray<AutomationRun> }) {
  if (runs.length === 0) {
    return <p className="px-10 pb-3 text-xs text-muted-foreground">No runs yet.</p>;
  }
  return (
    <ol className="flex flex-col gap-1.5 px-10 pb-3 text-xs">
      {runs.slice(0, 15).map((run) => {
        const threadRef = run.threadKey ? parseScopedThreadKey(run.threadKey) : null;
        return (
          <li key={run.id} className="flex min-w-0 items-baseline gap-2">
            <Badge variant={RUN_STATUS_VARIANT[run.status]} size="sm">
              {run.status}
            </Badge>
            <span className="shrink-0 text-muted-foreground">
              {formatRelativeTimeLabel(run.startedAt ?? run.createdAt)}
            </span>
            {threadRef ? (
              <Link
                className="shrink-0 hover:underline"
                to="/$environmentId/$threadId"
                params={{ environmentId: threadRef.environmentId, threadId: threadRef.threadId }}
              >
                Open chat
              </Link>
            ) : null}
            {run.reason ? (
              <span className="min-w-0 truncate text-muted-foreground">{run.reason}</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
