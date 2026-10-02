import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { Link } from "@tanstack/react-router";
import { PauseIcon, PlayIcon } from "lucide-react";
import { useState } from "react";
import { TicketWorkflow } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { useAutomations, useAutomationsDispatch } from "../../state/automations";
import { useBoardsDispatch } from "../../state/boards";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import type { TicketView } from "./useBoardsModel";

const NONE = "__none__";
const sameWorkflow = Schema.toEquivalence(TicketWorkflow);

export function TicketWorkflowSection({
  view,
  readOnly,
}: {
  readonly view: TicketView;
  readonly readOnly: boolean;
}) {
  const automations = useAutomations();
  const dispatch = useBoardsDispatch();
  const execute = useAutomationsDispatch();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { ticket } = view;
  const workflow = ticket.workflow;
  const presets =
    automations.status === "ready"
      ? automations.snapshot.automations.filter(
          (preset) => preset.trigger.type === "workflow" && preset.enabled,
        )
      : [];
  const owner = view.threads.find(
    (thread) =>
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === ticket.workflowThreadKey,
  );
  const ownerRef = ticket.workflowThreadKey ? parseScopedThreadKey(ticket.workflowThreadKey) : null;
  const running =
    Boolean(
      owner &&
      (threadRuntimeIsActive(owner.runtime) ||
        owner.hasPendingApprovals ||
        owner.hasPendingUserInput ||
        (owner.pendingBackgroundTasks?.length ?? 0) > 0),
    ) ||
    (automations.status === "ready" &&
      automations.snapshot.runs.some(
        (run) => run.ticketId === ticket.id && run.status === "running",
      ));
  const latestPreset = presets.find((preset) => preset.id === workflow?.presetId);
  const presetChanged = Boolean(
    workflow &&
    latestPreset &&
    !sameWorkflow(workflow, {
      presetId: latestPreset.id,
      title: latestPreset.title,
      prompt: latestPreset.prompt,
      action: latestPreset.action,
    }),
  );
  const assign = async (id: string) => {
    const preset = presets.find((candidate) => candidate.id === id);
    if (id !== NONE && !preset) return;
    setDraft(null);
    await dispatch({
      type: "ticket.update",
      ticketId: ticket.id,
      workflow: preset
        ? { presetId: preset.id, title: preset.title, prompt: preset.prompt, action: preset.action }
        : null,
    });
  };
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await execute({
        type: running ? "ticket.pauseWorkflow" : "ticket.startWorkflow",
        ticketId: ticket.id,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-medium">Workflow</h2>
        <div className="flex items-center gap-2">
          {ownerRef ? (
            <Button
              size="xs"
              variant="ghost"
              render={<Link to="/$environmentId/$threadId" params={ownerRef} />}
            >
              Open workflow chat
            </Button>
          ) : null}
          {workflow && !readOnly ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || automations.status !== "ready" || draft !== null}
              onClick={() => void run()}
            >
              {running ? <PauseIcon /> : <PlayIcon />}
              {busy ? "Working…" : running ? "Pause" : ownerRef ? "Resume" : "Start"}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={workflow?.presetId ?? NONE}
          disabled={readOnly || running || busy || automations.status !== "ready"}
          onValueChange={(id) => {
            if (id) void assign(String(id));
          }}
        >
          <SelectTrigger aria-label="Ticket workflow">
            <SelectValue>{workflow?.title ?? "No workflow"}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem value={NONE}>No workflow</SelectItem>
            {workflow && !latestPreset ? (
              <SelectItem value={workflow.presetId}>{workflow.title} (retired preset)</SelectItem>
            ) : null}
            {presets.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {preset.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          size="xs"
          variant="ghost"
          render={<Link to="/automations" search={{ tab: "workflows" }} />}
        >
          Manage presets
        </Button>
      </div>
      {workflow ? (
        draft !== null ? (
          <div className="flex flex-col gap-2">
            <Textarea
              aria-label="Ticket workflow instructions"
              rows={8}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="flex gap-2">
              <Button
                size="xs"
                disabled={!draft.trim() || busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await dispatch({
                      type: "ticket.update",
                      ticketId: ticket.id,
                      workflow: { ...workflow, prompt: draft.trim() },
                    });
                    if (result !== undefined) setDraft(null);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Save instructions
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <ChatMarkdown text={workflow.prompt} cwd={undefined} isStreaming={false} />
            {!readOnly ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="xs" variant="ghost" onClick={() => setDraft(workflow.prompt)}>
                  Edit ticket instructions
                </Button>
                {latestPreset && presetChanged ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={running || busy}
                    onClick={() => void assign(latestPreset.id)}
                  >
                    Apply latest preset
                  </Button>
                ) : null}
                <span className="text-xs text-muted-foreground">
                  Changes here apply to this ticket.
                </span>
              </div>
            ) : null}
          </>
        )
      ) : (
        <p className="text-sm text-muted-foreground">
          Choose instructions for completing this ticket, then Start. Moving columns records
          progress.
        </p>
      )}
    </section>
  );
}
